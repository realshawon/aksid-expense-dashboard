// AKSID Expense backend — single serverless function (Vercel + Neon Postgres)
// Routes by ?action= (or JSON body.action): init | list | get | submit | approve | reject
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);

// Approval pipeline order. After the last one is approved → "Ready to Post" (Accounts reviews the
// ledger/cost-center mapping and posts to Zoho manually) → "Posted".
const STAGES = ['Manager', 'Audit', 'Accounts', 'Top Mgmt'];
const READY = 'Ready to Post';

// --- Zoho Books ledger map (source of truth = ZOHO_EXPENSE_MAPPING.md §2, org 898189923) ---
// The submit form offers exactly these categories; keywords only guess for legacy free-text entries.
const LEDGERS = [
  { key: 'stationery',  label: 'Printing / Photocopy / Stationery', account: 'GAEXP - Printing, photocopy and stationery', account_id: '7058826000000465015', kw: ['lamination', 'print', 'photocopy', 'stationery', 'id card', 'paper', 'pen', 'toner'] },
  { key: 'fuel',        label: 'Fuel for Vehicle',                  account: 'GAEXP - Fuel for vehicle',                   account_id: '7058826000000465159', kw: ['fuel', 'petrol', 'octane', 'diesel'] },
  { key: 'toll',        label: 'Toll & Parking',                    account: 'GAEXP - Toll and perking vehicle',           account_id: '7058826000000749035', kw: ['toll', 'parking', 'perking'] },
  { key: 'conveyance',  label: 'Local Conveyance (bus/CNG/rickshaw/ride)', account: 'GAEXP - Local conveyance',            account_id: '7058826000000462295', kw: ['conveyance', 'rickshaw', 'uber', 'pathao', 'bus', 'cng', 'auto', 'fare', 'transport'] },
  { key: 'travel',      label: 'Travelling (tour/TA/DA)',           account: 'GAEXP - Travelling expense',                 account_id: '7058826000000465167', kw: ['travel', 'tour', 'ta/da', 'daily allowance'] },
  { key: 'food',        label: 'Food / Entertainment / Refreshment', account: 'GAEXP - Entertainment',                     account_id: '7058826000000462303', kw: ['food', 'lunch', 'refreshment', 'entertainment', 'snacks', 'tea', 'late night'] },
  { key: 'mobile',      label: 'Mobile Bill / Recharge',            account: 'GAEXP - Mobile bill',                        account_id: '7058826000000465047', kw: ['mobile', 'recharge', 'sim', 'talktime'] },
  { key: 'internet',    label: 'Internet Bill',                     account: 'GAEXP - Internet bill',                      account_id: '7058826000000465063', kw: ['internet', 'wifi', 'broadband'] },
  { key: 'courier',     label: 'Courier / Postage',                 account: 'GAEXP - Postage and courier charges',        account_id: '7058826000000465003', kw: ['courier', 'postage', 'parcel', 'shipment'] },
  { key: 'repair',      label: 'Repair & Maintenance',              account: 'GAEXP - Repair and maintenance',             account_id: '7058826000000465079', kw: ['repair', 'maintenance', 'servicing', 'spare'] },
  { key: 'medical',     label: 'Medical Expense',                   account: 'GAEXP - Medical expense',                    account_id: '7058826000000465111', kw: ['medical', 'medicine', 'doctor', 'pharmacy'] },
  { key: 'computer',    label: 'Computer / IT Accessories',         account: 'GAEXP - Computer Accessories Exp',           account_id: '7058826000000749245', kw: ['computer', 'it ', 'it expense', 'hardware', 'accessories', 'mouse', 'keyboard', 'cable'] },
  { key: 'labour',      label: 'Labour Bill',                       account: 'GAEXP - Labour bill',                        account_id: '7058826000000798325', kw: ['labour', 'labor', 'mistri', 'worker'] },
  { key: 'electricity', label: 'Electricity Bill / Electric Items', account: 'GAEXP - Electricity bill',                   account_id: '7058826000000749149', kw: ['electricity', 'electric', 'current bill'] },
  { key: 'cleaning',    label: 'Cleaning / Housekeeping',           account: 'GAEXP - Cleaning expense',                   account_id: '7058826000000465135', kw: ['cleaning', 'cleaner', 'housekeeping'] },
  { key: 'gift',        label: 'Gift & Donation',                   account: 'GAEXP - Gift and donation',                  account_id: '7058826000000465103', kw: ['gift', 'donation', 'hadia'] },
  { key: 'rent',        label: 'Office / House Rent',               account: 'GAEXP - Office rent',                        account_id: '7058826000000462279', kw: ['office rent', 'house rent'] },
  { key: 'construction', label: 'Construction Material',            account: 'DEXP - Materials',                           account_id: '7058826000000749063', kw: ['construction', 'cement', 'rod', 'steel', 'brick', 'sand', 'aggregate', 'tiles', 'material', 'raw material'] },
  { key: 'office',      label: 'Office Expense (general)',          account: 'GAEXP - Office expense',                     account_id: '7058826000000465031', kw: [] },
];
const DEFAULT_LEDGER = LEDGERS.find(l => l.key === 'office');

// Departments / cost centers. `tag` must be an existing option of the Zoho "Head Office" reporting
// tag (ZOHO_EXPENSE_MAPPING.md §2b) — labels without their own Zoho tag fall back to Head Office.
const DEPARTMENTS = [
  { label: 'Head Office',            tag: 'Head Office' },
  { label: 'Administration',         tag: 'Administration' },
  { label: 'Finance and Accounts',   tag: 'Finance and Accounts' },
  { label: 'Audit',                  tag: 'Audit' },
  { label: 'Human Resources',        tag: 'Human Resources' },
  { label: 'MIS / IT',               tag: 'MIS' },
  { label: 'Marketing and Brand',    tag: 'Marketing' },
  { label: 'Purchase',               tag: 'Purchase' },
  { label: 'Management',             tag: 'Management' },
  { label: 'Construction Team',      tag: 'Construction Team' },
  { label: 'Engineering Team',       tag: 'Engineering Team' },
  { label: 'Logistics',              tag: 'Logistics' },
  { label: 'Sales Team - SIKA',      tag: 'Sales Team - SIKA' },
  { label: 'Institution Sales',      tag: 'Head Office' },
  { label: 'Retail Sales',           tag: 'Head Office' },
];

function resolveLedger(e) {
  if (e.category_key) { const hit = LEDGERS.find(l => l.key === e.category_key); if (hit) return hit; }
  const text = ((e.category || '') + ' ' + (e.description || '')).toLowerCase();
  for (const l of LEDGERS) { if (l.kw.some(k => text.includes(k))) return l; }
  return DEFAULT_LEDGER;
}
function resolveDeptTag(costCenter) {
  const t = (costCenter || '').toLowerCase();
  const exact = DEPARTMENTS.find(d => d.label.toLowerCase() === t.trim());
  if (exact) return exact.tag;
  if (/market|brand/.test(t)) return 'Marketing';
  if (/account|finance/.test(t)) return 'Finance and Accounts';
  if (/audit/.test(t)) return 'Audit';
  if (/\bhr\b|human resource/.test(t)) return 'Human Resources';
  if (/mis|\bit\b|system/.test(t)) return 'MIS';
  if (/purchase|procurement/.test(t)) return 'Purchase';
  if (/management|\bmd\b|chairman|director/.test(t)) return 'Management';
  if (/construction/.test(t)) return 'Construction Team';
  if (/engineer/.test(t)) return 'Engineering Team';
  if (/logistic/.test(t)) return 'Logistics';
  if (/sika/.test(t)) return 'Sales Team - SIKA';
  if (/admin|office/.test(t)) return 'Administration';
  return 'Head Office';
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function initDb() {
  await sql`CREATE TABLE IF NOT EXISTS expenses (
    id SERIAL PRIMARY KEY,
    ref TEXT,
    employee_name TEXT,
    employee_id TEXT,
    employee_email TEXT,
    cost_center TEXT,
    expense_date DATE,
    category TEXT,
    vendor TEXT,
    description TEXT,
    amount NUMERIC,
    edited_amount NUMERIC,
    receipt_url TEXT,
    manager_email TEXT,
    stage TEXT DEFAULT 'Manager',
    history JSONB DEFAULT '[]'::jsonb,
    zoho_posted BOOLEAN DEFAULT false,
    zoho_expense_id TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS attachments (
    id SERIAL PRIMARY KEY,
    expense_id INT,
    name TEXT,
    content_type TEXT,
    data TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
  )`;
  await sql`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS receipts JSONB DEFAULT '[]'::jsonb`;
  await sql`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS category_key TEXT`;      // dropdown key → LEDGERS
  await sql`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS posting JSONB`;          // final lines posted to Zoho
  // Payment settlement (after Zoho posting): Accounts marks Paid → submitter confirms Received.
  await sql`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS settlement_status TEXT`; // null | 'paid' | 'closed' | 'issue'
  await sql`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS payment_method TEXT`;
  await sql`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS payment_ref TEXT`;
  await sql`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS payment_date DATE`;
  await sql`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS paid_by TEXT`;
  await sql`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ`;
  await sql`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ`;
  await sql`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS issue_note TEXT`;
  await sql`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS issue_at TIMESTAMPTZ`;
}

// --- Self-healing schema: make sure the tables/columns exist before any request runs.
// initDb uses IF NOT EXISTS everywhere, so this is safe & idempotent to call on every cold start.
let schemaReady = false;
async function ensureSchema() {
  if (schemaReady) return;
  await initDb();
  schemaReady = true;
}
function isSchemaError(err) {
  const m = String((err && err.message) || err || '').toLowerCase();
  return m.includes('does not exist') || m.includes('undefined column') || m.includes('relation') || m.includes('no such');
}

function effectiveAmount(row) {
  return (row.edited_amount != null) ? Number(row.edited_amount) : Number(row.amount);
}

const APP_BASE = process.env.APP_BASE_URL || 'https://aksid-expense-dashboard.vercel.app';
const LOGO = 'https://images.squarespace-cdn.com/content/v1/61b1d88771230e2244b14213/de522f80-4556-42c4-af20-e3687e746991/AKSID-HORIZONTAL-LOGO.png?format=750w';

// Fixed approver mailboxes per stage (Manager comes from the submission). Overridable via env.
const AUDIT_EMAIL = process.env.AUDIT_EMAIL || 'audit@aksidcorp.com';
const ACCOUNTS_EMAIL = process.env.ACCOUNTS_EMAIL || 'accounts@aksidcorp.com';
const ACCOUNTS2_EMAIL = process.env.ACCOUNTS2_EMAIL || 'accounts2@aksidcorp.com';
const TOPMGMT_EMAIL = process.env.TOPMGMT_EMAIL || 'saud@aksidcorp.com';
const IT_EMAIL = process.env.IT_EMAIL || 'it@aksidcorp.com'; // monitoring — BCC only

function approverEmail(expense, stage) {
  if (stage === 'Manager') return expense.manager_email || '';
  if (stage === 'Audit') return AUDIT_EMAIL;
  if (stage === 'Accounts') return ACCOUNTS_EMAIL;
  if (stage === 'Top Mgmt') return TOPMGMT_EMAIL;
  return '';
}
function allParties(expense) {
  return [expense.employee_email, AUDIT_EMAIL, ACCOUNTS_EMAIL, ACCOUNTS2_EMAIL, TOPMGMT_EMAIL];
}
// Dedupe + drop blanks, and never put IT in the visible To (IT is BCC only)
function toList(arr) {
  const seen = new Set(); const out = [];
  for (const e of arr) {
    const v = (e || '').trim();
    const k = v.toLowerCase();
    if (v && k !== IT_EMAIL.toLowerCase() && !seen.has(k)) { seen.add(k); out.push({ address: v }); }
  }
  return out;
}
const BCC_IT = [{ address: IT_EMAIL }];

function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function money(n) { return '৳' + Math.round(Number(n || 0)).toLocaleString('en-US'); }
function stageLabel(s) { return s === 'Manager' ? 'Reporting' : (s === READY ? 'Accounts — posting to Zoho' : s); }
// Rich note for Zoho (employee · dept · purpose · vendor) so the posted expense reads the same as a manual entry
function zohoNotes(e) {
  // Zoho/Make caps the Description at 100 chars — keep it concise: employee · dept · category · vendor
  const parts = [String(e.employee_name || ''), e.cost_center || '', e.category || '', e.vendor || ''];
  return parts.filter(x => x && String(x).trim()).join(' · ').slice(0, 100);
}

function approveUrlRaw(expense, stage) {
  return APP_BASE + '/approve.html?id=' + expense.id + '&role=' + encodeURIComponent(stage || '');
}
function approveButton(expense, stage) {
  const url = approveUrlRaw(expense, stage);
  return '<a href="' + url + '" style="display:inline-block;padding:12px 26px;background:#2a6df4;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:700;font-family:Segoe UI,Arial,sans-serif;font-size:15px">Review &amp; Approve</a>';
}
function receiptLink(url) {
  if (!url) return '—';
  return '<a href="' + esc(url) + '" style="color:#2a6df4;text-decoration:underline;font-weight:700">Open Receipt ↗</a>';
}
function receiptsCell(e) {
  let list = Array.isArray(e.receipts) ? e.receipts : [];
  if (!list.length && e.receipt_url) list = [{ name: 'Receipt', url: e.receipt_url }];
  if (!list.length) return '';
  const links = list.map((r, i) => '<a href="' + esc(r.url) + '" style="color:#2a6df4;text-decoration:underline;font-weight:700">Open ' + esc(r.name || ('Receipt ' + (i + 1))) + ' ↗</a>').join('<br>');
  return row('Receipts', links);
}
function row(label, value, bold) {
  return '<tr><td style="padding:5px 14px 5px 0;color:#6b7280;font-size:13px;white-space:nowrap;vertical-align:top">' + esc(label) + '</td>'
    + '<td style="padding:5px 0;font-size:13px;color:#111827;' + (bold ? 'font-weight:700' : '') + '">' + value + '</td></tr>';
}
function detailRows(e, finalAmount) {
  const amt = (finalAmount != null) ? finalAmount : effectiveAmount(e);
  return row('Employee', esc(e.employee_name) + (e.employee_id ? (' · ID ' + esc(e.employee_id)) : ''))
    + row('Cost Center', esc(e.cost_center))
    + row('Date', e.expense_date ? String(e.expense_date).slice(0, 10) : '—')
    + row('Category', esc(e.category))
    + row('Vendor', esc(e.vendor), true)
    + row('Description', esc(e.description), true)
    + row('Amount', money(amt), true);
}
function emailHead() {
  return '<div style="font-family:Segoe UI,Arial,sans-serif;max-width:560px;margin:0 auto;color:#111827">'
    + '<img src="' + LOGO + '" alt="AKSID" style="height:32px;margin:0 0 16px">';
}
function emailFoot() {
  return '<p style="margin:18px 0 0;font-size:11px;color:#9ca3af"><b style="color:#111827">DO NOT PRINT — SAVE PAPER.</b></p></div>';
}
function lastComment(e) {
  const h = Array.isArray(e.history) ? e.history : [];
  for (let i = h.length - 1; i >= 0; i--) { if (h[i] && h[i].comment) return h[i].comment; }
  return '';
}
function approvalTrail(e) {
  const h = Array.isArray(e.history) ? e.history : [];
  const appr = h.filter(x => x.action === 'approved');
  if (!appr.length) return '<div style="font-size:12.5px;color:#9ca3af">—</div>';
  return appr.map(x => '<div style="font-size:12.5px;color:#111827;margin:3px 0">✓ <b>' + esc(stageLabel(x.stage)) + '</b> '
    + money(x.amount) + ((x.by && String(x.by).includes('@')) ? ' <span style="color:#9ca3af">· ' + esc(x.by) + '</span>' : '')
    + (x.sealed ? ' <span style="display:inline-block;background:#0e7490;color:#ffffff;font-size:10px;font-weight:700;padding:1px 7px;border-radius:4px;letter-spacing:.04em">&#10003; AUDIT SEAL</span>' : '')
    + (x.comment ? ' <span style="color:#6b7280">— “' + esc(x.comment) + '”</span>' : '') + '</div>').join('');
}
function sectionLabel(t) {
  return '<p style="font-size:11px;color:#6b7280;margin:14px 0 4px;font-weight:700;text-transform:uppercase;letter-spacing:.05em">' + t + '</p>';
}

// Compact email at each approval step (with the action button)
function stepEmail(e, stage) {
  const hasTrail = (Array.isArray(e.history) ? e.history : []).some(x => x.action === 'approved');
  const html = emailHead()
    + '<p style="font-size:15px;margin:0 0 2px"><b>Expense ' + esc(e.ref) + '</b> needs your approval.</p>'
    + '<p style="font-size:13px;color:#6b7280;margin:0 0 14px">Currently with: <b style="color:#2a6df4">' + esc(stageLabel(stage)) + '</b></p>'
    + '<table style="border-collapse:collapse;margin:0 0 16px">' + detailRows(e)
    + receiptsCell(e) + '</table>'
    + (hasTrail ? sectionLabel('Approved so far') + approvalTrail(e) + '<div style="height:14px"></div>' : '')
    + '<p style="margin:0">' + approveButton(e, stage) + '</p>'
    + emailFoot();
  return { subject: 'AKSID Expense ' + e.ref + ' — ' + stageLabel(stage), html };
}

// Final summary email to everyone after Top Management approval + Zoho posting
function summaryEmail(e) {
  const orig = Number(e.amount);
  const fin = effectiveAmount(e);
  const edited = (e.edited_amount != null && Number(e.edited_amount) !== orig);
  const comment = lastComment(e);
  const amtCell = money(fin) + (edited ? ' <span style="color:#9ca3af;font-weight:400">(original ' + money(orig) + ')</span>' : '');
  const rows = row('Employee', esc(e.employee_name) + (e.employee_id ? (' · ID ' + esc(e.employee_id)) : ''))
    + row('Cost Center', esc(e.cost_center))
    + row('Date', e.expense_date ? String(e.expense_date).slice(0, 10) : '—')
    + row('Category', esc(e.category))
    + row('Vendor', esc(e.vendor), true)
    + row('Description', esc(e.description), true)
    + row('Amount', amtCell, true)
    + receiptsCell(e);
  const html = emailHead()
    + '<p style="font-size:17px;font-weight:700;margin:0 0 2px">Expense Approval Summary</p>'
    + (e.zoho_posted ? '<p style="font-size:13px;color:#16a34a;font-weight:700;margin:0 0 14px">✅ Approved by all · posted to Zoho Books · ' + esc(e.ref) + '</p>' : '<p style="font-size:13px;color:#b45309;font-weight:700;margin:0 0 14px">✅ Approved by all · ⚠️ NOT yet posted to Zoho Books — Accounts please post manually · ' + esc(e.ref) + '</p>')
    + '<table style="border-collapse:collapse;margin:0 0 8px">' + rows + '</table>'
    + sectionLabel('Approval Trail') + approvalTrail(e)
    + (comment ? sectionLabel('Top Management Comment') + '<p style="font-size:13px;color:#111827;margin:0;padding:9px 13px;background:#f3f4f6;border-radius:8px">' + esc(comment) + '</p>' : '')
    + sectionLabel('Next: payment')
    + '<p style="font-size:13px;color:#6b7280;margin:0 0 10px">Accounts: once the reimbursement is paid, record it so the submitter can confirm receipt.</p>'
    + '<p style="margin:0 0 4px">' + settleButton(settleUrl(e, 'Accounts'), '💸 Record Payment') + '</p>'
    + emailFoot();
  return { subject: (e.zoho_posted ? '' : '⚠️ Zoho posting failed — ') + 'Expense Approval Summary — ' + e.ref + (e.vendor ? ' (' + e.vendor + ')' : ''), html };
}

function readyToPostEmail(e) {
  const led = resolveLedger(e);
  const tag = resolveDeptTag(e.cost_center);
  const url = APP_BASE + '/post.html';
  const html = emailHead()
    + '<p style="font-size:15px;margin:0 0 2px"><b>Expense ' + esc(e.ref) + '</b> is fully approved — ready to post to Zoho Books.</p>'
    + '<p style="font-size:13px;color:#6b7280;margin:0 0 14px">Review the ledger &amp; cost-center mapping, then post it from the queue. Nothing goes to Zoho until you confirm.</p>'
    + '<table style="border-collapse:collapse;margin:0 0 14px">' + detailRows(e)
    + row('Suggested Ledger', esc(led.account))
    + row('Suggested Tag', esc(tag))
    + receiptsCell(e) + '</table>'
    + '<p style="margin:0"><a href="' + url + '" style="display:inline-block;padding:12px 26px;background:#0e7490;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:700;font-family:Segoe UI,Arial,sans-serif;font-size:15px">Open Posting Queue</a></p>'
    + emailFoot();
  return { subject: 'Ready to post — ' + e.ref + ' · ' + money(effectiveAmount(e)) + (e.vendor ? ' (' + e.vendor + ')' : ''), html };
}

function rejectedEmail(e) {
  const h = Array.isArray(e.history) ? e.history : [];
  const last = h[h.length - 1] || {};
  const html = emailHead()
    + '<p style="font-size:15px;color:#b91c1c;font-weight:700;margin:0 0 10px">Expense ' + esc(e.ref) + ' was rejected</p>'
    + '<table style="border-collapse:collapse;margin:0 0 14px">'
    + row('Employee', esc(e.employee_name))
    + row('Vendor', esc(e.vendor), true)
    + row('Description', esc(e.description), true)
    + row('Amount', money(effectiveAmount(e)), true)
    + row('Rejected by', esc(last.by || '—'))
    + (last.reason ? row('Reason', esc(last.reason)) : '') + '</table>'
    + emailFoot();
  return { subject: 'AKSID Expense ' + e.ref + ' — Rejected', html };
}

function submitterUpdateEmail(e, fromStage, toStage) {
  const html = emailHead()
    + '<p style="font-size:15px;margin:0 0 2px">Your expense <b>' + esc(e.ref) + '</b> has been approved.</p>'
    + '<p style="font-size:13px;color:#6b7280;margin:0 0 14px">Approved at <b>' + esc(stageLabel(fromStage)) + '</b> — now with <b style="color:#2a6df4">' + esc(stageLabel(toStage)) + '</b>. No action needed from you.</p>'
    + '<table style="border-collapse:collapse;margin:0 0 14px">' + detailRows(e) + receiptsCell(e) + '</table>'
    + emailFoot();
  return { subject: 'Your expense ' + e.ref + ' — approved at ' + stageLabel(fromStage) + ', now with ' + stageLabel(toStage), html };
}

// ---- Payment settlement (after Zoho posting) ----
function settleUrl(e, role) {
  return APP_BASE + '/settle.html?id=' + e.id + '&role=' + encodeURIComponent(role || '');
}
function settleButton(url, label, bg) {
  return '<a href="' + url + '" style="display:inline-block;padding:12px 26px;background:' + (bg || '#2a6df4') + ';color:#ffffff;text-decoration:none;border-radius:8px;font-weight:700;font-family:Segoe UI,Arial,sans-serif;font-size:15px">' + label + '</a>';
}
function paymentRows(e) {
  return row('Payment method', esc(e.payment_method || '—'), true)
    + row('Reference', esc(e.payment_ref || '—'))
    + row('Payment date', e.payment_date ? String(e.payment_date).slice(0, 10) : '—');
}
// Accounts marked it paid → ask the SUBMITTER to confirm they received the money.
function paidEmail(e) {
  const url = settleUrl(e, 'submitter');
  const html = emailHead()
    + '<p style="font-size:15px;margin:0 0 2px">💸 Your reimbursement for <b>' + esc(e.ref) + '</b> has been paid.</p>'
    + '<p style="font-size:13px;color:#6b7280;margin:0 0 14px">Please confirm you received it — or let Accounts know if you did not.</p>'
    + '<table style="border-collapse:collapse;margin:0 0 14px">'
    + row('Amount', money(effectiveAmount(e)), true) + paymentRows(e) + '</table>'
    + '<p style="margin:0 0 10px">' + settleButton(url, '✅ I received it', '#16a34a') + '</p>'
    + '<p style="font-size:12px;color:#6b7280;margin:0">Didn\'t receive it? <a href="' + url + '" style="color:#b91c1c;font-weight:700">Report a problem</a>.</p>'
    + emailFoot();
  return { subject: 'Your reimbursement ' + e.ref + ' has been paid — please confirm receipt', html };
}
// Submitter confirmed receipt → notify Accounts / Top Management that it's fully closed.
function closedEmail(e) {
  const html = emailHead()
    + '<p style="font-size:15px;color:#16a34a;font-weight:700;margin:0 0 2px">✅ ' + esc(e.ref) + ' is fully closed.</p>'
    + '<p style="font-size:13px;color:#6b7280;margin:0 0 14px">The submitter confirmed they received the payment. No further action needed.</p>'
    + '<table style="border-collapse:collapse;margin:0 0 14px">'
    + row('Employee', esc(e.employee_name)) + row('Amount', money(effectiveAmount(e)), true) + paymentRows(e) + '</table>'
    + emailFoot();
  return { subject: 'Expense ' + e.ref + ' — closed (receipt confirmed)', html };
}
// Submitter reported NOT received → alert Accounts.
function notReceivedEmail(e) {
  const html = emailHead()
    + '<p style="font-size:15px;color:#b91c1c;font-weight:700;margin:0 0 2px">⚠️ Payment issue reported — ' + esc(e.ref) + '</p>'
    + '<p style="font-size:13px;color:#6b7280;margin:0 0 14px">The submitter says they have NOT received this reimbursement. Please follow up.</p>'
    + '<table style="border-collapse:collapse;margin:0 0 14px">'
    + row('Employee', esc(e.employee_name) + (e.employee_email ? (' · ' + esc(e.employee_email)) : '')) + row('Amount', money(effectiveAmount(e)), true) + paymentRows(e)
    + (e.issue_note ? row('Note', esc(e.issue_note)) : '') + '</table>'
    + emailFoot();
  return { subject: '⚠️ Reimbursement ' + e.ref + ' — submitter reports NOT received', html };
}

// Confirmation to the SUBMITTER the moment their expense is filed (so they always get a mail on every submission).
function submittedConfirmEmail(e) {
  const html = emailHead()
    + '<p style="font-size:15px;margin:0 0 2px">✅ Your expense <b>' + esc(e.ref) + '</b> has been submitted.</p>'
    + '<p style="font-size:13px;color:#6b7280;margin:0 0 14px">It is now with your <b style="color:#2a6df4">Reporting</b> manager for approval. You will be emailed at every step — no action needed from you.</p>'
    + '<table style="border-collapse:collapse;margin:0 0 14px">' + detailRows(e) + receiptsCell(e) + '</table>'
    + emailFoot();
  return { subject: 'Your expense ' + e.ref + ' — submitted, now with Reporting', html };
}

async function postWebhook(url, payload) {
  if (!url) return false;
  // Retry with backoff so a transient network/gateway blip doesn't drop the message.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (r.ok) return true;
    } catch (e) { /* fall through to retry */ }
    if (attempt < 2) await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
  }
  return false;
}

// --- Outgoing "firewall": guarantee every notification payload is well-formed before it leaves.
// This is what stops a malformed record (bad/empty recipients) from ever reaching — and breaking — the mailer.
function validRecipients(arr) {
  return Array.isArray(arr) && arr.length > 0 && arr.every(x => x && typeof x.address === 'string' && /.+@.+\..+/.test(x.address));
}
async function postNotify(payload) {
  if (payload) {
    if (!validRecipients(payload.to)) {
      // normalize whatever we were given (strings or objects) into [{address}]
      payload.to = toList((payload.to || []).map(x => (typeof x === 'string' ? x : (x && x.address) || '')));
    }
    if (!Array.isArray(payload.bcc)) payload.bcc = [];
    // if there is still nobody valid to send to, skip silently rather than emit a broken payload
    if (!validRecipients(payload.to)) return false;
  }
  return await postWebhook(process.env.MAKE_NOTIFY_WEBHOOK, payload);
}

async function postWebhookJson(url, payload) {
  if (!url) return null;
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!r.ok) return null;
    const t = await r.text();
    try { return JSON.parse(t); } catch (_) { return { raw: t }; }
  } catch (e) { return null; }
}
function sanitizePart(s) {
  return String(s || '').trim().replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}
// Send the receipt to the Make "Receipt Filer" (OneDrive) webhook; returns the anonymous view link.
async function fileReceipt(row, b64, origName, contentType) {
  const url = process.env.MAKE_RECEIPT_WEBHOOK;
  if (!url || !b64) return '';
  const dot = (origName || '').lastIndexOf('.');
  const ext = (dot >= 0 ? origName.slice(dot + 1) : 'bin').toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin';
  const d = row.expense_date ? new Date(row.expense_date) : new Date();
  const yyyy = String(d.getFullYear()); const mm = String(d.getMonth() + 1).padStart(2, '0'); const dd = String(d.getDate()).padStart(2, '0');
  const dept = sanitizePart(row.cost_center) || 'General';
  const fname = [yyyy + '-' + mm + '-' + dd, sanitizePart(row.category), sanitizePart(row.vendor), Math.round(effectiveAmount(row)), row.ref].filter(Boolean).join('_') + '.' + ext;
  const folder = dept + '/' + yyyy + '/' + mm;
  const resp = await postWebhookJson(url, { file_base64: b64, filename: fname, folder: folder, content_type: contentType || 'application/octet-stream', department: dept, ref: row.ref });
  if (!resp) return '';
  return resp.link || resp.url || resp.webUrl || (resp.raw && /^https?:\/\//.test(String(resp.raw).trim()) ? String(resp.raw).trim() : '') || '';
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const action = (req.query.action || body.action || (req.method === 'GET' ? 'list' : '')).toString();

  try {
    if (!process.env.DATABASE_URL) {
      return res.status(500).json({ ok: false, error: 'DATABASE_URL not set — connect the Neon database to this Vercel project.' });
    }

    // Self-heal: guarantee the schema exists before we touch it (cheap, idempotent, cached per instance).
    await ensureSchema();

    // --- init: create the table (run once) ---
    if (action === 'init') {
      await initDb();
      return res.json({ ok: true, message: 'Database initialized.' });
    }

    // --- health: self-check the whole system (safe/read-only). Auto-repairs the schema on the way. ---
    if (action === 'health') {
      const checks = {};
      try { await sql`SELECT 1`; checks.database = 'ok'; } catch (e) { checks.database = 'FAIL: ' + String((e && e.message) || e); }
      try { schemaReady = false; await ensureSchema(); checks.schema = 'ok'; } catch (e) { checks.schema = 'FAIL: ' + String((e && e.message) || e); }
      checks.config = {
        database_url: !!process.env.DATABASE_URL,
        notify_webhook: !!process.env.MAKE_NOTIFY_WEBHOOK,
        zoho_webhook: !!process.env.MAKE_ZOHO_WEBHOOK,
      };
      const counts = {};
      let pending = 0, unpostedFinal = 0;
      try {
        const rows = await sql`SELECT stage, count(*)::int AS c FROM expenses GROUP BY stage`;
        for (const r of rows) { counts[r.stage] = r.c; if (!['Posted', 'Rejected'].includes(r.stage)) pending += r.c; }
      } catch (e) { checks.counts = 'FAIL: ' + String((e && e.message) || e); }
      try { const u = await sql`SELECT count(*)::int AS c FROM expenses WHERE stage = 'Posted' AND zoho_posted = false`; unpostedFinal = u[0] ? u[0].c : 0; } catch (e) {}
      const healthy = checks.database === 'ok' && checks.schema === 'ok' && checks.config.database_url;
      return res.json({
        ok: healthy,
        status: healthy ? 'operational' : 'degraded',
        checks,
        counts,
        pending_approvals: pending,
        approved_but_not_in_zoho: unpostedFinal,
        at: new Date().toISOString(),
      });
    }

    // --- list: all expenses (for the dashboard) ---
    if (action === 'list') {
      const rows = await sql`SELECT * FROM expenses ORDER BY created_at DESC LIMIT 200`;
      return res.json({ ok: true, stages: STAGES, expenses: rows });
    }

    // --- get: a single expense (for the approval page) ---
    if (action === 'get') {
      const id = req.query.id || body.id;
      const rows = await sql`SELECT * FROM expenses WHERE id = ${id}`;
      if (!rows.length) return res.status(404).json({ ok: false, error: 'Not found' });
      return res.json({ ok: true, expense: rows[0], stages: STAGES });
    }

    // --- resend: re-send the current-stage approver email (fresh, correct link) ---
    if (action === 'resend') {
      if ((req.query.key || body.key) !== (process.env.ADMIN_KEY || 'aksid-admin-2026')) return res.status(403).json({ ok: false, error: 'Forbidden' });
      const rid = req.query.id || body.id;
      const rrows = await sql`SELECT * FROM expenses WHERE id = ${rid}`;
      if (!rrows.length) return res.status(404).json({ ok: false, error: 'Not found' });
      const ex = rrows[0];
      if (ex.stage === 'Posted' || ex.stage === 'Rejected') return res.status(400).json({ ok: false, error: 'Not pending: ' + ex.stage });
      const rem = stepEmail(ex, ex.stage);
      await postNotify({ event: 'resend', expense: ex, stage: ex.stage, to: toList([approverEmail(ex, ex.stage)]), bcc: BCC_IT, email_subject: rem.subject, email_html: rem.html });
      return res.json({ ok: true, message: 'Re-sent ' + ex.ref + ' to ' + ex.stage });
    }

    // --- config: dropdown lists for the forms (single source of truth for categories/departments) ---
    if (action === 'config') {
      return res.json({
        ok: true,
        categories: LEDGERS.map(l => ({ key: l.key, label: l.label, account: l.account, account_id: l.account_id })),
        departments: DEPARTMENTS.map(d => ({ label: d.label, tag: d.tag })),
      });
    }

    // --- postqueue: fully-approved expenses awaiting Zoho posting, with suggested mapping (admin) ---
    if (action === 'postqueue') {
      if ((req.query.key || body.key) !== (process.env.ADMIN_KEY || 'aksid-admin-2026')) return res.status(403).json({ ok: false, error: 'Forbidden' });
      const rows = await sql`SELECT * FROM expenses WHERE stage = ${READY} ORDER BY updated_at ASC`;
      const out = rows.map(r => {
        const led = resolveLedger(r);
        return { ...r, suggestion: { category_key: led.key, account: led.account, account_id: led.account_id, tag: resolveDeptTag(r.cost_center) } };
      });
      return res.json({ ok: true, expenses: out });
    }

    // --- postToZoho: Accounts confirms the mapping (and optional cost-center split) → write to Zoho ---
    if (action === 'postToZoho') {
      if ((req.query.key || body.key) !== (process.env.ADMIN_KEY || 'aksid-admin-2026')) return res.status(403).json({ ok: false, error: 'Forbidden' });
      const pid = req.query.id || body.id;
      const rows = await sql`SELECT * FROM expenses WHERE id = ${pid}`;
      if (!rows.length) return res.status(404).json({ ok: false, error: 'Not found' });
      const ex = rows[0];
      if (ex.stage !== READY) return res.status(400).json({ ok: false, error: 'Not ready to post (stage=' + ex.stage + ')' });
      const total = effectiveAmount(ex);
      // lines: [{account_id, account_name, tag, amount}] — defaults to the suggestion as a single line
      let lines = Array.isArray(body.lines) && body.lines.length ? body.lines : null;
      if (!lines) {
        const led = resolveLedger(ex);
        lines = [{ account_id: led.account_id, account_name: led.account, tag: resolveDeptTag(ex.cost_center), amount: total }];
      }
      lines = lines.map(l => ({ account_id: String(l.account_id || ''), account_name: String(l.account_name || ''), tag: String(l.tag || 'Head Office'), amount: Number(l.amount || 0) }));
      if (lines.some(l => !l.account_id || !(l.amount > 0))) return res.status(400).json({ ok: false, error: 'Every line needs an account and a positive amount.' });
      const sum = lines.reduce((s, l) => s + l.amount, 0);
      if (Math.abs(sum - total) > 0.01) return res.status(400).json({ ok: false, error: 'Lines total ' + sum.toFixed(2) + ' but the approved amount is ' + total.toFixed(2) + '.' });
      // receipts go along so Make can attach them to the Zoho expense
      const atts = await sql`SELECT id, name, content_type, data FROM attachments WHERE expense_id = ${ex.id} ORDER BY id ASC`;
      const receipts = atts.map(a => ({ name: a.name, content_type: a.content_type, file_base64: a.data, url: APP_BASE + '/api?action=receipt&aid=' + a.id }));
      const payload = {
        ref: ex.ref,
        employee_name: ex.employee_name,
        employee_id: ex.employee_id,
        cost_center: ex.cost_center,
        expense_date: ex.expense_date,
        category: ex.category,
        vendor: ex.vendor,
        description: zohoNotes(ex),
        amount: total,
        // resolved mapping — Make maps these straight into Zoho instead of a hardcoded account
        account_id: lines[0].account_id,
        account_name: lines[0].account_name,
        tag_option: lines[0].tag,
        line_items: lines,
        is_split: lines.length > 1,
        receipts,
      };
      let posted = await postWebhook(process.env.MAKE_ZOHO_WEBHOOK, payload);
      if (!posted) posted = await postWebhook(process.env.MAKE_ZOHO_WEBHOOK, payload);
      if (!posted) return res.status(502).json({ ok: false, error: 'Zoho webhook did not accept the posting — expense left in the queue.' });
      const hist = Array.isArray(ex.history) ? ex.history : [];
      hist.push({ stage: READY, action: 'posted', by: body.by || 'Accounts', at: new Date().toISOString(), lines });
      await sql`UPDATE expenses SET stage = 'Posted', zoho_posted = true, posting = ${JSON.stringify(lines)}::jsonb, history = ${JSON.stringify(hist)}::jsonb, updated_at = now() WHERE id = ${ex.id}`;
      const updated = (await sql`SELECT * FROM expenses WHERE id = ${ex.id}`)[0];
      const em = summaryEmail(updated);
      await postNotify({ event: 'posted', expense: updated, stage: 'Posted', to: toList(allParties(updated)), bcc: BCC_IT, email_subject: em.subject, email_html: em.html });
      return res.json({ ok: true, expense: updated });
    }

    // --- addAttachment: attach a file to an EXISTING expense (viewable by current + all later approvers) ---
    if (action === 'addAttachment') {
      if ((req.query.key || body.key) !== (process.env.ADMIN_KEY || 'aksid-admin-2026')) return res.status(403).json({ ok: false, error: 'Forbidden' });
      const tid = req.query.id || body.id;
      const trows = await sql`SELECT * FROM expenses WHERE id = ${tid}`;
      if (!trows.length) return res.status(404).json({ ok: false, error: 'Not found' });
      const ex = trows[0];
      const b64 = body.file_base64;
      if (!b64) return res.status(400).json({ ok: false, error: 'file_base64 required' });
      const name = (body.filename || 'attachment').toString();
      const ctype = (body.content_type || 'application/octet-stream').toString();
      const ins = await sql`INSERT INTO attachments (expense_id, name, content_type, data) VALUES (${ex.id}, ${name}, ${ctype}, ${b64}) RETURNING id`;
      const newAid = ins[0].id;
      const url = APP_BASE + '/api?action=receipt&aid=' + newAid;
      const list = Array.isArray(ex.receipts) ? ex.receipts : [];
      list.push({ aid: newAid, name, url });
      await sql`UPDATE expenses SET receipts = ${JSON.stringify(list)}::jsonb, receipt_url = COALESCE(NULLIF(receipt_url, ''), ${url}), updated_at = now() WHERE id = ${ex.id}`;
      try { await fileReceipt(ex, b64, name, ctype); } catch (_) {}
      const updated = (await sql`SELECT * FROM expenses WHERE id = ${ex.id}`)[0];
      return res.json({ ok: true, aid: newAid, url, expense: updated });
    }

    // --- pay: Accounts records the reimbursement payment (only after fully approved + posted) ---
    if (action === 'pay') {
      const pid = req.query.id || body.id;
      const prows = await sql`SELECT * FROM expenses WHERE id = ${pid}`;
      if (!prows.length) return res.status(404).json({ ok: false, error: 'Not found' });
      const ex = prows[0];
      if (ex.stage !== 'Posted') return res.status(400).json({ ok: false, error: 'Not payable yet — must be fully approved & posted. Current: ' + ex.stage });
      if (ex.settlement_status === 'paid' || ex.settlement_status === 'closed') return res.status(409).json({ ok: false, error: 'Already ' + ex.settlement_status });
      const method = (body.method || '').toString().trim();
      const pref = (body.ref || '').toString().trim();
      const pdate = ((body.date || '').toString().trim()) || new Date().toISOString().slice(0, 10);
      if (!method) return res.status(400).json({ ok: false, error: 'Payment method is required' });
      await sql`UPDATE expenses SET settlement_status = 'paid', payment_method = ${method}, payment_ref = ${pref}, payment_date = ${pdate}, paid_by = ${(body.by || 'Accounts')}, paid_at = now(), issue_note = NULL, issue_at = NULL, updated_at = now() WHERE id = ${pid}`;
      const updated = (await sql`SELECT * FROM expenses WHERE id = ${pid}`)[0];
      if (updated.employee_email) {
        const pe = paidEmail(updated);
        await postNotify({ event: 'paid', expense: updated, to: toList([updated.employee_email]), bcc: BCC_IT, email_subject: pe.subject, email_html: pe.html });
      }
      return res.json({ ok: true, expense: updated });
    }

    // --- confirmReceipt: submitter confirms they received the money → fully closed ---
    if (action === 'confirmReceipt') {
      const cid = req.query.id || body.id;
      const crows = await sql`SELECT * FROM expenses WHERE id = ${cid}`;
      if (!crows.length) return res.status(404).json({ ok: false, error: 'Not found' });
      const ex = crows[0];
      if (ex.settlement_status === 'closed') return res.json({ ok: true, expense: ex }); // idempotent
      if (ex.settlement_status !== 'paid' && ex.settlement_status !== 'issue') return res.status(400).json({ ok: false, error: 'Not marked paid yet.' });
      await sql`UPDATE expenses SET settlement_status = 'closed', received_at = now(), issue_note = NULL, issue_at = NULL, updated_at = now() WHERE id = ${cid}`;
      const updated = (await sql`SELECT * FROM expenses WHERE id = ${cid}`)[0];
      const ce = closedEmail(updated);
      await postNotify({ event: 'closed', expense: updated, to: toList([ACCOUNTS_EMAIL, ACCOUNTS2_EMAIL, TOPMGMT_EMAIL]), bcc: BCC_IT, email_subject: ce.subject, email_html: ce.html });
      return res.json({ ok: true, expense: updated });
    }

    // --- reportNotReceived: submitter flags they did NOT receive the money → alert Accounts ---
    if (action === 'reportNotReceived') {
      const nid = req.query.id || body.id;
      const nrows = await sql`SELECT * FROM expenses WHERE id = ${nid}`;
      if (!nrows.length) return res.status(404).json({ ok: false, error: 'Not found' });
      const ex = nrows[0];
      if (ex.settlement_status !== 'paid' && ex.settlement_status !== 'issue') return res.status(400).json({ ok: false, error: 'Not marked paid yet.' });
      const note = (body.note || '').toString().trim().slice(0, 500);
      await sql`UPDATE expenses SET settlement_status = 'issue', issue_note = ${note}, issue_at = now(), updated_at = now() WHERE id = ${nid}`;
      const updated = (await sql`SELECT * FROM expenses WHERE id = ${nid}`)[0];
      const ne = notReceivedEmail(updated);
      await postNotify({ event: 'not_received', expense: updated, to: toList([ACCOUNTS_EMAIL, ACCOUNTS2_EMAIL]), bcc: BCC_IT, email_subject: ne.subject, email_html: ne.html });
      return res.json({ ok: true, expense: updated });
    }

    // --- receipt: serve an uploaded attachment by id (so approvers can view it) ---
    if (action === 'receipt') {
      const aid = req.query.aid || body.aid;
      const rows = await sql`SELECT name, content_type, data FROM attachments WHERE id = ${aid}`;
      if (!rows.length) return res.status(404).json({ ok: false, error: 'Not found' });
      const a = rows[0];
      const buf = Buffer.from(a.data || '', 'base64');
      res.setHeader('Content-Type', a.content_type || 'application/octet-stream');
      res.setHeader('Content-Disposition', 'inline; filename="' + String(a.name || 'receipt').replace(/[^A-Za-z0-9._-]/g, '_') + '"');
      return res.status(200).send(buf);
    }

    // --- submit: create a new expense (from the form / Make / web) ---
    if (action === 'submit') {
      const e = body;
      const inserted = await sql`INSERT INTO expenses
        (employee_name, employee_id, employee_email, cost_center, expense_date, category, category_key, vendor, description, amount, receipt_url, manager_email, stage, history)
        VALUES (${e.employee_name || ''}, ${e.employee_id || ''}, ${e.employee_email || ''}, ${e.cost_center || ''},
                ${e.expense_date || null}, ${e.category || ''}, ${e.category_key || null}, ${e.vendor || ''}, ${e.description || ''},
                ${e.amount || 0}, ${e.receipt_url || ''}, ${e.manager_email || ''}, 'Manager',
                ${JSON.stringify([{ stage: 'Submitted', at: new Date().toISOString(), by: e.employee_name || '' }])}::jsonb)
        RETURNING *`;
      const row = inserted[0];
      const ref = 'EXP-' + (1000000 + Number(row.id)); // 7-digit serial, starts with 1 (no leading zeros for Excel)
      await sql`UPDATE expenses SET ref = ${ref} WHERE id = ${row.id}`;
      row.ref = ref;
      // store uploaded receipt(s) — viewable via app links; also archive to OneDrive if the filer webhook is set
      let files = Array.isArray(e.receipt_files) ? e.receipt_files.slice(0, 10) : [];
      if (!files.length && e.receipt_file) files = [{ file_base64: e.receipt_file, filename: e.receipt_filename, content_type: e.receipt_content_type }];
      const receipts = [];
      for (const f of files) {
        if (!f || !f.file_base64) continue;
        try {
          const ins = await sql`INSERT INTO attachments (expense_id, name, content_type, data) VALUES (${row.id}, ${f.filename || 'receipt'}, ${f.content_type || 'application/octet-stream'}, ${f.file_base64}) RETURNING id`;
          const aid = ins[0].id;
          receipts.push({ aid, name: f.filename || ('Receipt ' + (receipts.length + 1)), url: APP_BASE + '/api?action=receipt&aid=' + aid });
          try { await fileReceipt(row, f.file_base64, f.filename, f.content_type); } catch (_) {}
        } catch (err) {
          // one bad/oversized attachment shouldn't wipe out the others already saved
          console.error('attachment insert failed:', f.filename, err && err.message);
        }
      }
      if (receipts.length) {
        await sql`UPDATE expenses SET receipts = ${JSON.stringify(receipts)}::jsonb, receipt_url = ${receipts[0].url} WHERE id = ${row.id}`;
        row.receipts = receipts; row.receipt_url = receipts[0].url;
      }
      // notify (current approver = Manager)
      const em0 = stepEmail(row, 'Manager');
      await postNotify({ event: 'submitted', expense: row, stage: 'Manager', to: toList([approverEmail(row, 'Manager')]), bcc: BCC_IT, email_subject: em0.subject, email_html: em0.html });
      // confirm to the submitter that we received their expense (they get a mail on every submission)
      if (row.employee_email) {
        const sc = submittedConfirmEmail(row);
        await postNotify({ event: 'submitted_confirm', expense: row, stage: 'Manager', to: toList([row.employee_email]), bcc: BCC_IT, email_subject: sc.subject, email_html: sc.html });
      }
      return res.json({ ok: true, expense: row });
    }

    // --- approve: advance the stage; on final approval, post to Zoho via Make ---
    if (action === 'approve') {
      const id = body.id || req.query.id;
      const by = body.by || body.approver || 'approver';
      const rows = await sql`SELECT * FROM expenses WHERE id = ${id}`;
      if (!rows.length) return res.status(404).json({ ok: false, error: 'Not found' });
      const row = rows[0];
      if (row.stage === 'Posted' || row.stage === 'Rejected' || row.stage === READY) {
        return res.status(400).json({ ok: false, error: row.stage === READY ? 'Already fully approved — pending posting by Accounts.' : ('Already ' + row.stage) });
      }
      // stale link guard: the email was for a specific stage; if it has moved on, don't let this approver act on the wrong stage
      if (STAGES.includes(by) && by !== row.stage) {
        return res.status(409).json({ ok: false, error: 'You have already approved this — it is now with ' + row.stage + '.' });
      }
      // optional edited amount applied at this stage
      let edited = row.edited_amount;
      if (body.editedAmount != null && body.editedAmount !== '') edited = Number(body.editedAmount);

      const idx = STAGES.indexOf(row.stage);
      if (idx === -1) return res.status(400).json({ ok: false, error: 'Unknown stage: ' + row.stage });
      const isFinal = idx === STAGES.length - 1;
      const nextStage = isFinal ? READY : STAGES[idx + 1];

      const comment = (body.comment != null && String(body.comment).trim() !== '') ? String(body.comment).trim() : undefined;
      // Audit seal: only the Audit stage can apply it
      const sealed = (row.stage === 'Audit' && (body.auditSeal === true || body.auditSeal === 'true')) ? true : undefined;
      const history = Array.isArray(row.history) ? row.history : [];
      history.push({ stage: row.stage, action: 'approved', by, at: new Date().toISOString(), amount: (edited != null ? Number(edited) : Number(row.amount)), comment, sealed });

      await sql`UPDATE expenses
        SET stage = ${nextStage}, edited_amount = ${edited}, history = ${JSON.stringify(history)}::jsonb, updated_at = now()
        WHERE id = ${id}`;

      const updated = (await sql`SELECT * FROM expenses WHERE id = ${id}`)[0];

      if (isFinal) {
        // Fully approved → hold for Accounts posting review (ledger, cost-center split, attachment
        // are all confirmed by a human on post.html before anything reaches Zoho).
        const rp = readyToPostEmail(updated);
        await postNotify({ event: 'ready_to_post', expense: updated, stage: READY, to: toList([ACCOUNTS_EMAIL, ACCOUNTS2_EMAIL]), bcc: BCC_IT, email_subject: rp.subject, email_html: rp.html });
      } else {
        const em = stepEmail(updated, nextStage);
        await postNotify({ event: 'advanced', expense: updated, stage: nextStage, to: toList([approverEmail(updated, nextStage)]), bcc: BCC_IT, email_subject: em.subject, email_html: em.html });
      }
      // keep the submitter informed on every approval (IT on BCC); the posted summary comes later
      if (updated.employee_email) {
        const su = submitterUpdateEmail(updated, row.stage, nextStage);
        await postNotify({ event: 'submitter_update', expense: updated, stage: nextStage, to: toList([updated.employee_email]), bcc: BCC_IT, email_subject: su.subject, email_html: su.html });
      }
      return res.json({ ok: true, expense: updated });
    }

    // --- setManager: change manager_email of an expense (and re-send if currently at Manager) ---
    if (action === 'setManager') {
      if ((req.query.key || body.key) !== (process.env.ADMIN_KEY || 'aksid-admin-2026')) return res.status(403).json({ ok: false, error: 'Forbidden' });
      const sid = req.query.id || body.id;
      const newEmail = (req.query.email || body.email || '').toString().trim();
      if (!newEmail) return res.status(400).json({ ok: false, error: 'email required' });
      const srows = await sql`SELECT * FROM expenses WHERE id = ${sid}`;
      if (!srows.length) return res.status(404).json({ ok: false, error: 'Not found' });
      await sql`UPDATE expenses SET manager_email = ${newEmail}, updated_at = now() WHERE id = ${sid}`;
      const ss = (await sql`SELECT * FROM expenses WHERE id = ${sid}`)[0];
      let sent = false;
      if (ss.stage === 'Manager') {
        const sem = stepEmail(ss, 'Manager');
        await postNotify({ event: 'manager_changed', expense: ss, stage: 'Manager', to: toList([newEmail]), bcc: BCC_IT, email_subject: sem.subject, email_html: sem.html });
        sent = true;
      }
      return res.json({ ok: true, message: 'Manager email set for ' + ss.ref + ' to ' + newEmail + (sent ? ' (re-sent)' : '') });
    }

    // --- unreject: recover a Rejected expense back to a chosen stage (admin only) ---
    if (action === 'unreject') {
      if ((req.query.key || body.key) !== (process.env.ADMIN_KEY || 'aksid-admin-2026')) return res.status(403).json({ ok: false, error: 'Forbidden' });
      const uid = req.query.id || body.id;
      const target = (req.query.stage || body.stage || 'Manager').toString();
      if (!STAGES.includes(target)) return res.status(400).json({ ok: false, error: 'Bad stage: ' + target });
      const urows = await sql`SELECT * FROM expenses WHERE id = ${uid}`;
      if (!urows.length) return res.status(404).json({ ok: false, error: 'Not found' });
      const ur = urows[0];
      if (ur.stage !== 'Rejected') return res.status(400).json({ ok: false, error: 'Not rejected (stage=' + ur.stage + ')' });
      const uhist = Array.isArray(ur.history) ? ur.history : [];
      uhist.push({ stage: 'Rejected', action: 'unrejected', by: 'admin', at: new Date().toISOString(), to_stage: target });
      await sql`UPDATE expenses SET stage = ${target}, history = ${JSON.stringify(uhist)}::jsonb, updated_at = now() WHERE id = ${uid}`;
      const uu = (await sql`SELECT * FROM expenses WHERE id = ${uid}`)[0];
      const uem = stepEmail(uu, target);
      await postNotify({ event: 'unrejected', expense: uu, stage: target, to: toList([approverEmail(uu, target)]), bcc: BCC_IT, email_subject: uem.subject, email_html: uem.html });
      return res.json({ ok: true, message: 'Recovered ' + uu.ref + ' back to ' + target });
    }

    // --- reject ---
    if (action === 'reject') {
      const id = body.id || req.query.id;
      const by = body.by || 'approver';
      const reason = body.reason || '';
      const rows = await sql`SELECT * FROM expenses WHERE id = ${id}`;
      if (!rows.length) return res.status(404).json({ ok: false, error: 'Not found' });
      const row = rows[0];
      const history = Array.isArray(row.history) ? row.history : [];
      history.push({ stage: row.stage, action: 'rejected', by, at: new Date().toISOString(), reason });
      await sql`UPDATE expenses SET stage = 'Rejected', history = ${JSON.stringify(history)}::jsonb, updated_at = now() WHERE id = ${id}`;
      const updated = (await sql`SELECT * FROM expenses WHERE id = ${id}`)[0];
      const emR = rejectedEmail(updated);
      await postNotify({ event: 'rejected', expense: updated, stage: 'Rejected', to: toList([updated.employee_email, updated.manager_email]), bcc: BCC_IT, email_subject: emR.subject, email_html: emR.html });
      return res.json({ ok: true, expense: updated });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action: ' + action });
  } catch (err) {
    // Self-heal: if the failure looks like a missing table/column, repair the schema so the next call succeeds.
    if (isSchemaError(err)) {
      try { schemaReady = false; await ensureSchema(); } catch (_) {}
      return res.status(503).json({ ok: false, error: 'Temporary schema issue was auto-repaired — please retry.', detail: String((err && err.message) || err) });
    }
    return res.status(500).json({ ok: false, error: String((err && err.message) || err) });
  }
}

// redeploy trigger 1782107167
