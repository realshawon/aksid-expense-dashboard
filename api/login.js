// POST /api/login   { identifier, password }  -> sets the exp_session cookie
// DELETE /api/login                            -> clears it
//
// Credentials are verified against the ERP's own app_user row. Nothing is
// stored here. See api/_auth.js for why this is the only available integration.
import { login, makeSessionCookie, clearSessionCookie } from './_auth.js';

async function readBody(req) {
  let body = req.body;
  if (typeof body === 'string') { try { return JSON.parse(body); } catch { return {}; } }
  if (body) return body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'DELETE') {
    res.setHeader('Set-Cookie', clearSessionCookie());
    return res.status(200).json({ ok: true });
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  }

  const body = await readBody(req);
  const identifier = body.identifier || body.email || '';
  const password = body.password || '';

  try {
    const result = await login(identifier, password);
    if (!result.ok) {
      // Never log the submitted password, and never echo which part failed.
      return res.status(401).json({ ok: false, error: result.error });
    }
    res.setHeader('Set-Cookie', await makeSessionCookie(result.session));
    const s = result.session;
    return res.status(200).json({
      ok: true,
      user: { name: s.name, email: s.email, role: s.role, empCode: s.empCode },
    });
  } catch (err) {
    console.error('login failed —', err.message);
    return res.status(500).json({ ok: false, error: 'Sign-in is temporarily unavailable.' });
  }
}
