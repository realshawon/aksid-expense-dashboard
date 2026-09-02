// Expense-side SSO callback.
//
// GET /api/sso?token=<jwt>
//   - verifies the JWT signature with shared AUTH_SECRET
//   - checks aud === "exp" and exp not passed
//   - records the jti in sso_nonce_used and rejects any repeat (replay)
//   - re-verifies the ERP user is still active + token_version matches
//   - mints the app's own exp_session cookie
//   - 302-redirects the browser to a clean URL (token stripped from URL)
//
// The ERP side is at ERP /api/sso/exchange?to=expense which mints the token
// and redirects here. Nothing else on this path — the browser is the only
// carrier of the token, and the redirect below removes it from history.
//
// If verification fails for any reason the user is sent to /login.html with
// a generic error — never leak which check failed.

import { jwtVerify } from 'jose';
import { neon } from '@neondatabase/serverless';
import { makeSessionCookie } from './_auth.js';

const sql = neon(process.env.DATABASE_URL);
const erpSql = neon(process.env.ERP_DATABASE_URL || process.env.DATABASE_URL);

const CALLBACK_LANDING = '/submit.html';
const LOGIN_URL = '/login.html?sso=failed';

let schemaReady = false;
async function ensureNonceTable() {
  if (schemaReady) return;
  await sql`
    CREATE TABLE IF NOT EXISTS sso_nonce_used (
      jti TEXT PRIMARY KEY,
      audience TEXT NOT NULL,
      used_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
  // TTL cleanup — nonces stop mattering after their 60s exp. Keep 24h then drop.
  await sql`DELETE FROM sso_nonce_used WHERE used_at < now() - interval '24 hours'`;
  schemaReady = true;
}

function redirect(res, url, status = 302) {
  res.setHeader('Location', url);
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).end();
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    console.error('sso: AUTH_SECRET missing');
    return redirect(res, LOGIN_URL);
  }

  const url = new URL(req.url, `https://${req.headers.host}`);
  const token = url.searchParams.get('token');
  if (!token) return redirect(res, LOGIN_URL);

  let payload;
  try {
    ({ payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
      audience: 'exp',
      clockTolerance: 5, // seconds; small allowance for clock drift between issuers
    }));
  } catch (e) {
    console.warn('sso: verify failed —', e && e.code || e && e.message);
    return redirect(res, LOGIN_URL);
  }

  const jti = String(payload.jti || '');
  const uid = Number(payload.uid);
  const tv = Number(payload.tv);
  if (!jti || !uid) return redirect(res, LOGIN_URL);

  try {
    await ensureNonceTable();
    // Atomic insert — duplicate jti = replay attempt → primary-key conflict.
    await sql`INSERT INTO sso_nonce_used (jti, audience) VALUES (${jti}, 'exp')`;
  } catch (e) {
    // duplicate_pk = replay; any other error = defer to a fresh login
    console.warn('sso: nonce insert rejected —', e && e.code || 'unknown');
    return redirect(res, LOGIN_URL);
  }

  // Re-verify against ERP right now — a password change / role change /
  // deactivate since the exchange 60s ago must invalidate this handoff.
  let rows;
  try {
    rows = await erpSql`
      SELECT u.id, u.email, u.active, u.token_version, u.employee_id, u.role,
             e.emp_code, e.full_name, e.email AS employee_email,
             d.name AS department
        FROM app_user u
        LEFT JOIN employee e ON e.id = u.employee_id
        LEFT JOIN department d ON d.id = e.department_id
       WHERE u.id = ${uid}`;
  } catch (e) {
    console.error('sso: ERP lookup failed —', e && e.message);
    return redirect(res, LOGIN_URL);
  }
  const u = rows[0];
  if (!u || !u.active) return redirect(res, LOGIN_URL);
  if (Number(u.token_version) !== tv) return redirect(res, LOGIN_URL);

  const sess = {
    userId: Number(u.id),
    employeeId: u.employee_id ? Number(u.employee_id) : null,
    email: String(u.email || '').toLowerCase(),
    empCode: u.emp_code || null,
    name: u.full_name || u.email,
    role: u.role || null,
    tv: u.token_version,
  };
  const cookie = await makeSessionCookie(sess);

  res.setHeader('Set-Cookie', cookie);
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Location', CALLBACK_LANDING);
  return res.status(302).end();
}
