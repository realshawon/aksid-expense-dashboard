// Shared ERP-backed authentication for the Expense app (2026-08-24).
//
// The ERP (erp.aksidcorp.com) is the single source of truth for identity,
// password and role. This app stores NO password of its own: it bcrypt-compares
// the submitted password against the ERP's existing `app_user.password_hash`
// in place. Consequence, and the whole point: when someone changes their ERP
// password the ERP bumps `app_user.token_version`, every session issued here
// stops verifying on its next request, and the next login uses the new ERP
// password. Nothing is ever synced or copied.
//
// The ERP exposes no login API (there is no POST /api/auth/login anywhere in
// aksid-erp-new — only an attendance-ingest route and a health check), so SSO /
// OAuth / OIDC are not available to integrate against. Reading the ERP's own
// database is the only officially-supported path, and is exactly what
// health-benefit-app already does in production.
//
// Cookie name is deliberately distinct from the ERP's `session` and Health
// Benefit's `hb_session` so a session can never cross between apps.
import { neon } from '@neondatabase/serverless';
import { SignJWT, jwtVerify } from 'jose';
import bcrypt from 'bcryptjs';

// The ERP database. Set ERP_DATABASE_URL to the ERP's Neon connection string.
// If the Expense app already shares the ERP's database, leave it unset and this
// falls back to DATABASE_URL — but set it explicitly if they are separate.
const erpSql = neon(process.env.ERP_DATABASE_URL || process.env.DATABASE_URL);

const COOKIE = 'exp_session';
const COOKIE_MAX_AGE = 60 * 60 * 8; // 8 hours, matching health-benefit-app
const LOCKOUT_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

function getSecret() {
  const s = process.env.AUTH_SECRET;
  // Fail closed. The ERP has a dev fallback literal; we deliberately do not
  // copy that, because this file runs in production only.
  if (!s) throw new Error('AUTH_SECRET is not set — it must match the ERP AUTH_SECRET.');
  return new TextEncoder().encode(s);
}

function readCookies(req) {
  const raw = req.headers?.cookie ?? '';
  const out = {};
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

/**
 * Verify the session cookie against the ERP database on every call.
 * Re-querying (rather than trusting the JWT alone) is what makes an ERP
 * password change, role change or deactivation take effect immediately.
 * Returns { userId, employeeId, email, name, empCode, role } or null.
 */
export async function getSession(req) {
  const token = readCookies(req)[COOKIE];
  if (!token) return null;

  let payload;
  try {
    ({ payload } = await jwtVerify(token, getSecret()));
  } catch {
    return null; // bad signature, expired, or tampered
  }
  const userId = payload.uid;
  if (!userId) return null;

  let rows;
  try {
    rows = await erpSql`
      SELECT u.id, u.email, u.active, u.token_version, u.employee_id, u.role,
             e.emp_code, e.full_name, d.name AS department
        FROM app_user u
        LEFT JOIN employee e ON e.id = u.employee_id
        LEFT JOIN department d ON d.id = e.department_id
       WHERE u.id = ${userId}`;
  } catch (err) {
    // Fail closed on a DB error rather than honouring an unverifiable token.
    console.error('getSession: ERP lookup failed —', err.message);
    return null;
  }

  const u = rows[0];
  if (!u) return null;
  if (!u.active) return null;
  if ((payload.tv ?? 1) !== u.token_version) return null; // revoked / password changed

  return {
    userId: Number(u.id),
    employeeId: u.employee_id ? Number(u.employee_id) : null,
    email: String(u.email || '').toLowerCase(),
    empCode: u.emp_code || null,
    name: u.full_name || u.email,
    role: u.role || null,
    department: u.department || null,
  };
}

/**
 * Authenticate an (identifier, password) pair against the ERP.
 * Identifier may be an ERP email or an employee code, matching how the ERP and
 * Health Benefit both behave. Mirrors the ERP's own lockout policy so this app
 * cannot be used as an oracle to brute-force ERP passwords.
 */
export async function login(identifier, password) {
  const id = String(identifier ?? '').trim().toLowerCase();
  if (!id || !password) return { ok: false, error: 'Email and password are required.' };

  const rows = await erpSql`
    SELECT u.id, u.email, u.password_hash, u.active, u.employee_id, u.token_version, u.role,
           u.failed_attempts, u.locked_until,
           e.emp_code, e.full_name
      FROM app_user u
      LEFT JOIN employee e ON e.id = u.employee_id
     WHERE (lower(u.email) = ${id} OR lower(e.emp_code) = ${id}) AND u.active`;

  const u = rows[0];
  // Same message whether the account is missing or the password is wrong, so
  // this endpoint cannot be used to enumerate ERP accounts.
  const GENERIC = 'Invalid email or password.';
  if (!u) return { ok: false, error: GENERIC };

  if (u.locked_until && new Date(u.locked_until) > new Date()) {
    return { ok: false, error: 'Account is temporarily locked — try again in a few minutes.' };
  }

  const ok = await bcrypt.compare(password, u.password_hash || '');
  if (!ok) {
    await erpSql`
      UPDATE app_user
         SET failed_attempts = failed_attempts + 1,
             locked_until = CASE WHEN failed_attempts + 1 >= ${LOCKOUT_ATTEMPTS}
                                 THEN now() + (${LOCKOUT_MINUTES} || ' minutes')::interval
                                 ELSE locked_until END
       WHERE id = ${u.id}`;
    return { ok: false, error: GENERIC };
  }

  await erpSql`
    UPDATE app_user
       SET last_login_at = now(), failed_attempts = 0, locked_until = NULL
     WHERE id = ${u.id}`;

  return {
    ok: true,
    session: {
      userId: Number(u.id),
      employeeId: u.employee_id ? Number(u.employee_id) : null,
      email: String(u.email || '').toLowerCase(),
      empCode: u.emp_code || null,
      name: u.full_name || u.email,
      role: u.role || null,
      tv: u.token_version,
    },
  };
}

/** Issue the session cookie. The JWT carries only {uid, tv} — no role, no PII. */
export async function makeSessionCookie(sess) {
  const jwt = await new SignJWT({ uid: sess.userId, tv: sess.tv })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${COOKIE_MAX_AGE}s`)
    .sign(getSecret());
  return `${COOKIE}=${encodeURIComponent(jwt)}; Max-Age=${COOKIE_MAX_AGE}; Path=/; HttpOnly; SameSite=Lax; Secure`;
}

export function clearSessionCookie() {
  return `${COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax; Secure`;
}

/** Client IP / user-agent for the audit trail. */
export function requestMeta(req) {
  const fwd = req.headers['x-forwarded-for'];
  const ip = (Array.isArray(fwd) ? fwd[0] : String(fwd || '')).split(',')[0].trim()
    || req.socket?.remoteAddress || null;
  return { ip: ip || null, userAgent: String(req.headers['user-agent'] || '').slice(0, 500) || null };
}
