// GET /api/me -> the current ERP-backed session, or 401.
// Re-validated against the ERP on every call (see api/_auth.js), so a
// deactivated user or a changed ERP password stops working immediately.
import { getSession } from './_auth.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const s = await getSession(req);
  if (!s) return res.status(401).json({ ok: false, error: 'Not signed in.' });
  return res.status(200).json({
    ok: true,
    user: { name: s.name, email: s.contactEmail || s.email, loginEmail: s.email, role: s.role, empCode: s.empCode, department: s.department },
  });
}
