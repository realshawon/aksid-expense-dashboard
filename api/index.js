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
}

function effectiveAmount(row) {
  return (row.edited_amount != null) ? Number(row.edited_amount) : Number(row.amount);
}

const APP_BASE = process.env.APP_BASE_URL || 'https://aksid-expense-dashboard.vercel.app';
function approveUrl(expense, stage) {
  const url = APP_BASE + '/approve.html?id=' + expense.id + '&role=' + encodeURIComponent(stage || '');
  // Pre-built HTML button so the notification email shows a clickable button (the email body is HTML).
  return '<a href="' + url + '" style="display:inline-block;padding:11px 22px;background:#2a6df4;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:700;font-family:Segoe UI,Arial,sans-serif">Review &amp; Approve</a>';
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
      // notify (current approver = Manager)
      await postWebhook(process.env.MAKE_NOTIFY_WEBHOOK, { event: 'submitted', expense: row, stage: 'Manager', approve_url: approveUrl(row, 'Manager') });
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
      // optional edited amount applied at this stage
      let edited = row.edited_amount;
      if (body.editedAmount != null && body.editedAmount !== '') edited = Number(body.editedAmount);

      const idx = STAGES.indexOf(row.stage);
      if (idx === -1) return res.status(400).json({ ok: false, error: 'Unknown stage: ' + row.stage });
      const isFinal = idx === STAGES.length - 1;
      const nextStage = isFinal ? 'Posted' : STAGES[idx + 1];

      const history = Array.isArray(row.history) ? row.history : [];
      history.push({ stage: row.stage, action: 'approved', by, at: new Date().toISOString(), amount: (edited != null ? Number(edited) : Number(row.amount)) });

      await sql`UPDATE expenses
        SET stage = ${nextStage}, edited_amount = ${edited}, history = ${JSON.stringify(history)}::jsonb, updated_at = now()
        WHERE id = ${id}`;

      const updated = (await sql`SELECT * FROM expenses WHERE id = ${id}`)[0];

      if (isFinal) {
        // Post to Zoho through the Make webhook (Webhook → Zoho Create Expense)
        const posted = await postWebhook(process.env.MAKE_ZOHO_WEBHOOK, {
          ref: updated.ref,
          employee_name: updated.employee_name,
          employee_id: updated.employee_id,
          cost_center: updated.cost_center,
          expense_date: updated.expense_date,
          category: updated.category,
          vendor: updated.vendor,
          description: updated.description,
          amount: effectiveAmount(updated),
        });
        if (posted) {
          await sql`UPDATE expenses SET zoho_posted = true WHERE id = ${id}`;
          updated.zoho_posted = true;
        }
      }
      await postWebhook(process.env.MAKE_NOTIFY_WEBHOOK, { event: isFinal ? 'posted' : 'advanced', expense: updated, stage: nextStage, approve_url: approveUrl(updated, nextStage) });
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
      await postWebhook(process.env.MAKE_NOTIFY_WEBHOOK, { event: 'rejected', expense: updated, stage: 'Rejected', approve_url: approveUrl(updated, 'Rejected') });
      return res.json({ ok: true, expense: updated });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action: ' + action });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err && err.message || err) });
  }
}
