// Who is allowed to approve what (2026-08-24).
//
// This is the single place the role policy lives — change the map below and
// nothing else needs touching. Roles are the ERP's own `app_user.role` values;
// the ERP's DB CHECK constraint permits exactly:
//   superadmin, admin, hr, dept_head, accounts, employee, audit
// (aksid-erp-new/db/schema.sql:405-406). Note the ERP's TypeScript union also
// lists 'accounts2' and 'it', which the CHECK would reject — do not rely on them.

/**
 * Approval stage -> ERP roles permitted to clear it.
 *
 * ASSUMPTIONS made in Shawon's absence, flagged for correction:
 *  - 'Top Management or Others' -> admin/superadmin, because the ERP has no
 *    'topmgmt' role. Change this line if a dedicated role is added.
 *  - accounts2@aksidcorp.com is treated as a notification mailbox only. If that
 *    person holds an ERP account with role 'accounts' they are authorised here
 *    automatically, with no special-casing.
 */
export const STAGE_ROLES = {
  'Manager': ['dept_head'],
  'Audit': ['audit'],
  'Accounts': ['accounts'],
  'Top Management or Others': ['admin', 'superadmin'],
  'Ready to Post': ['accounts'],
};

/** Roles that may run the admin/repair actions (edit, fixStage, unreject, delete…). */
export const ADMIN_ROLES = new Set(['admin', 'superadmin']);

/** Roles that may see the full expense list. Everyone else sees only their own. */
export const VIEW_ALL_ROLES = new Set([
  'superadmin', 'admin', 'audit', 'accounts', 'dept_head', 'hr',
]);

export const isAdmin = (session) => !!session && ADMIN_ROLES.has(session.role);
export const canViewAll = (session) => !!session && VIEW_ALL_ROLES.has(session.role);

/**
 * Decide whether `session` may act on `expense` at its CURRENT stage.
 * The stage is always read from the database row — never from the request, and
 * never from a URL parameter. Returns { ok } or { ok:false, status, error }.
 */
export function canActOnStage(session, expense) {
  if (!session) return { ok: false, status: 401, error: 'Not signed in.' };

  const stage = expense?.stage;
  if (!stage) return { ok: false, status: 404, error: 'Expense not found.' };

  // Terminal states cannot be acted on by anyone through this path.
  if (stage === 'Posted' || stage === 'Rejected') {
    return { ok: false, status: 409, error: `This expense is already ${stage.toLowerCase()}.` };
  }

  // Admins may act at any stage — deliberate override, and it is recorded in
  // the audit trail with their real ERP identity like any other approval.
  if (isAdmin(session)) return { ok: true, override: true };

  const allowed = STAGE_ROLES[stage];
  if (!allowed) return { ok: false, status: 409, error: `Unknown stage "${stage}".` };
  if (!allowed.includes(session.role)) {
    return { ok: false, status: 403, error: `This expense is with ${stage} — your ERP role (${session.role || 'none'}) cannot approve at that stage.` };
  }

  // 'Manager' is the one per-expense stage: the approver must be the specific
  // department head named on this expense, not merely anyone holding dept_head.
  if (stage === 'Manager') {
    const named = String(expense.manager_email || '').trim().toLowerCase();
    if (!named) return { ok: false, status: 409, error: 'No department head is set on this expense — ask Accounts to set one.' };
    if (named !== session.email) {
      return { ok: false, status: 403, error: 'This expense is routed to a different department head.' };
    }
  }

  return { ok: true };
}
