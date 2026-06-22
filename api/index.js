// AKSID Expense backend — single serverless function (Vercel + Neon Postgres)
// Routes by ?action= (or JSON body.action): init | list | get | submit | approve | reject
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);

// Approval pipeline order. After the last one is approved → "Posted".
const STAGES = ['Manager', 'Audit', 'Accounts', 'Top Mgmt'];

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
}

function effectiveAmount(row) {
  return (row.edited_amount != null) ? Number(row.edited_amount) : Number(row.amount);
}

const APP_BASE = process.env.APP_BASE_URL || 'https://aksid-expense-dashboard.vercel.app';
const LOGO = 'https://images.squarespace-cdn.com/content/v1/61b1d88771230e2244b14213/de522f80-4556-42c4-af20-e3687e746991/AKSID-HORIZONTAL-LOGO.png?format=750w';

// Fixed approver mailboxes per stage (Manager comes from the submission). Overridable via env.
const AUDIT_EMAIL = process.env.AUDIT_EMAIL || 'audit@aksidcorp.com';
const ACCOUNTS_EMAIL = process.env.ACCOUNTS_EMAIL || 'accounts@aksidcorp.com';
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
  return [expense.employee_email, expense.manager_email, AUDIT_EMAIL, ACCOUNTS_EMAIL, TOPMGMT_EMAIL];
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
  return appr.map(x => '<div style="font-size:12.5px;color:#111827;margin:3px 0">✓ <b>' + esc(x.stage) + '</b> '
    + money(x.amount) + (x.by ? ' <span style="color:#9ca3af">· ' + esc(x.by) + '</span>' : '')
    + (x.comment ? ' <span style="color:#6b7280">— “' + esc(x.comment) + '”</span>' : '') + '</div>').join('');
}
function sectionLabel(t) {
  return '<p style="font-size:11px;color:#6b7280;margin:14px 0 4px;font-weight:700;text-transform:uppercase;letter-spacing:.05em">' + t + '</p>';
}

// Compact email at each approval step (with the action button)
function stepEmail(e, stage) {
  const html = emailHead()
    + '<p style="font-size:15px;margin:0 0 2px"><b>Expense ' + esc(e.ref) + '</b> needs your approval.</p>'
    + '<p style="font-size:13px;color:#6b7280;margin:0 0 14px">Currently with: <b style="color:#2a6df4">' + esc(stage) + '</b></p>'
    + '<table style="border-collapse:collapse;margin:0 0 16px">' + detailRows(e)
    + receiptsCell(e) + '</table>'
    + '<p style="margin:0">' + approveButton(e, stage) + '</p>'
    + emailFoot();
  return { subject: 'AKSID Expense ' + e.ref + ' — ' + stage, html };
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
    + emailFoot();
  return { subject: (e.zoho_posted ? '' : '⚠️ Zoho posting failed — ') + 'Expense Approval Summary — ' + e.ref + (e.vendor ? ' (' + e.vendor + ')' : ''), html };
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
    + '<p style="font-size:13px;color:#6b7280;margin:0 0 14px">Approved at <b>' + esc(fromStage) + '</b> — now with <b style="color:#2a6df4">' + esc(toStage) + '</b>. No action needed from you.</p>'
    + '<table style="border-collapse:collapse;margin:0 0 14px">' + detailRows(e) + receiptsCell(e) + '</table>'
    + emailFoot();
  return { subject: 'Your expense ' + e.ref + ' — approved at ' + fromStage + ', now with ' + toStage, html };
}

async function postWebhook(url, payload) {
  if (!url) return false;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return r.ok;
  } catch (e) { return false; }
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

    // --- init: create the table (run once) ---
    if (action === 'init') {
      await initDb();
      return res.json({ ok: true, message: 'Database initialized.' });
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
      await postWebhook(process.env.MAKE_NOTIFY_WEBHOOK, { event: 'resend', expense: ex, stage: ex.stage, to: toList([approverEmail(ex, ex.stage)]), bcc: [], email_subject: rem.subject, email_html: rem.html });
      return res.json({ ok: true, message: 'Re-sent ' + ex.ref + ' to ' + ex.stage });
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
        (employee_name, employee_id, employee_email, cost_center, expense_date, category, vendor, description, amount, receipt_url, manager_email, stage, history)
        VALUES (${e.employee_name || ''}, ${e.employee_id || ''}, ${e.employee_email || ''}, ${e.cost_center || ''},
                ${e.expense_date || null}, ${e.category || ''}, ${e.vendor || ''}, ${e.description || ''},
                ${e.amount || 0}, ${e.receipt_url || ''}, ${e.manager_email || ''}, 'Manager',
                ${JSON.stringify([{ stage: 'Submitted', at: new Date().toISOString(), by: e.employee_name || '' }])}::jsonb)
        RETURNING *`;
      const row = inserted[0];
      const ref = 'EXP-' + String(row.id).padStart(4, '0');
      await sql`UPDATE expenses SET ref = ${ref} WHERE id = ${row.id}`;
      row.ref = ref;
      // store uploaded receipt(s) — viewable via app links; also archive to OneDrive if the filer webhook is set
      let files = Array.isArray(e.receipt_files) ? e.receipt_files.slice(0, 10) : [];
      if (!files.length && e.receipt_file) files = [{ file_base64: e.receipt_file, filename: e.receipt_filename, content_type: e.receipt_content_type }];
      const receipts = [];
      for (const f of files) {
        if (!f || !f.file_base64) continue;
        const ins = await sql`INSERT INTO attachments (expense_id, name, content_type, data) VALUES (${row.id}, ${f.filename || 'receipt'}, ${f.content_type || 'application/octet-stream'}, ${f.file_base64}) RETURNING id`;
        const aid = ins[0].id;
        receipts.push({ aid, name: f.filename || ('Receipt ' + (receipts.length + 1)), url: APP_BASE + '/api?action=receipt&aid=' + aid });
        try { await fileReceipt(row, f.file_base64, f.filename, f.content_type); } catch (_) {}
      }
      if (receipts.length) {
        await sql`UPDATE expenses SET receipts = ${JSON.stringify(receipts)}::jsonb, receipt_url = ${receipts[0].url} WHERE id = ${row.id}`;
        row.receipts = receipts; row.receipt_url = receipts[0].url;
      }
      // notify (current approver = Manager)
      const em0 = stepEmail(row, 'Manager');
      await postWebhook(process.env.MAKE_NOTIFY_WEBHOOK, { event: 'submitted', expense: row, stage: 'Manager', to: toList([approverEmail(row, 'Manager')]), bcc: BCC_IT, email_subject: em0.subject, email_html: em0.html });
      return res.json({ ok: true, expense: row });
    }

    // --- approve: advance the stage; on final approval, post to Zoho via Make ---
    if (action === 'approve') {
      const id = body.id || req.query.id;
      const by = body.by || body.approver || 'approver';
      const rows = await sql`SELECT * FROM expenses WHERE id = ${id}`;
      if (!rows.length) return res.status(404).json({ ok: false, error: 'Not found' });
      const row = rows[0];
      if (row.stage === 'Posted' || row.stage === 'Rejected') {
        return res.status(400).json({ ok: false, error: 'Already ' + row.stage });
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
      const nextStage = isFinal ? 'Posted' : STAGES[idx + 1];

      const comment = (body.comment != null && String(body.comment).trim() !== '') ? String(body.comment).trim() : undefined;
      const history = Array.isArray(row.history) ? row.history : [];
      history.push({ stage: row.stage, action: 'approved', by, at: new Date().toISOString(), amount: (edited != null ? Number(edited) : Number(row.amount)), comment });

      await sql`UPDATE expenses
        SET stage = ${nextStage}, edited_amount = ${edited}, history = ${JSON.stringify(history)}::jsonb, updated_at = now()
        WHERE id = ${id}`;

      const updated = (await sql`SELECT * FROM expenses WHERE id = ${id}`)[0];

      if (isFinal) {
        // Post to Zoho through the Make webhook (Webhook → Zoho Create Expense)
        const zohoPayload = {
          ref: updated.ref,
          employee_name: updated.employee_name,
          employee_id: updated.employee_id,
          cost_center: updated.cost_center,
          expense_date: updated.expense_date,
          category: updated.category,
          vendor: updated.vendor,
          description: updated.description,
          amount: effectiveAmount(updated),
        };
        let posted = await postWebhook(process.env.MAKE_ZOHO_WEBHOOK, zohoPayload);
        if (!posted) posted = await postWebhook(process.env.MAKE_ZOHO_WEBHOOK, zohoPayload);
        if (posted) {
          await sql`UPDATE expenses SET zoho_posted = true WHERE id = ${id}`;
          updated.zoho_posted = true;
        }
      }
      const em = isFinal ? summaryEmail(updated) : stepEmail(updated, nextStage);
      const toRecipients = isFinal ? toList(allParties(updated)) : toList([approverEmail(updated, nextStage)]);
      await postWebhook(process.env.MAKE_NOTIFY_WEBHOOK, { event: isFinal ? 'posted' : 'advanced', expense: updated, stage: nextStage, to: toRecipients, bcc: isFinal ? BCC_IT : [], email_subject: em.subject, email_html: em.html });
      // keep the submitter informed on every intermediate approval (IT on BCC); the final summary already reaches them
      if (!isFinal && updated.employee_email) {
        const su = submitterUpdateEmail(updated, row.stage, nextStage);
        await postWebhook(process.env.MAKE_NOTIFY_WEBHOOK, { event: 'submitter_update', expense: updated, stage: nextStage, to: toList([updated.employee_email]), bcc: BCC_IT, email_subject: su.subject, email_html: su.html });
      }
      return res.json({ ok: true, expense: updated });
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
      await postWebhook(process.env.MAKE_NOTIFY_WEBHOOK, { event: 'rejected', expense: updated, stage: 'Rejected', to: toList([updated.employee_email, updated.manager_email]), bcc: BCC_IT, email_subject: emR.subject, email_html: emR.html });
      return res.json({ ok: true, expense: updated });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action: ' + action });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err && err.message || err) });
  }
}
