# AKSID Expense App — deploy (Vercel + Neon)

Fully-automatic expense system: submit → Manager → Audit → Accounts → Top Management → **auto-post to Zoho**, with a **live dashboard** that reads the database.

## Pieces
- **Neon Postgres** `neon-beige-castle` (already created in your Vercel) = the system of record.
- **This repo** (static pages + one serverless function `/api`) = app + dashboard.
- **Make webhook → Zoho Create Expense** = posts the final-approved expense (reuses the *AKSID Zoho Books* connection).

## Files
- `index.html` — live tracker dashboard (reads `/api?action=list`)
- `submit.html` — web submission form (POST `/api` action=submit)
- `approve.html?id=N&role=manager` — approver clicks from the email; Approve/Reject + edit amount
- `api/index.js` — backend: init · list · get · submit · approve · reject
- `package.json` — dependency `@neondatabase/serverless`

## One-time setup (your clicks)
1. **Import to Vercel:** Vercel → Add New → Project → import `realshawon/aksid-expense-dashboard` → Deploy.
2. **Connect the database:** Vercel project → Storage → connect **neon-beige-castle**. This injects `DATABASE_URL` automatically. Redeploy.
3. **Create the table:** open `https://<your-app>.vercel.app/api?action=init` once → should say *Database initialized.*
4. **Add the Zoho webhook env:** after building the Make webhook scenario (below), set env var `MAKE_ZOHO_WEBHOOK` = that webhook URL in Vercel → Settings → Environment Variables → redeploy.
   (Optional `MAKE_NOTIFY_WEBHOOK` = a Make webhook that sends Email/WhatsApp at each stage.)

## Make webhook → Zoho (final-approval posting)
New Make scenario:
1. **Webhooks → Custom webhook** (copy its URL → that's `MAKE_ZOHO_WEBHOOK`).
2. **Zoho Books → Create an Expense** (connection = *AKSID Zoho Books*), map:
   - Organization = AKSID Corporation Limited
   - Paid through = Petty cash (head office)
   - Account = map from webhook `category` (see ZOHO_EXPENSE_MAPPING.md; default Office expense)
   - Date = webhook `expense_date` · Amount = webhook `amount`
   - Vendor = webhook `vendor` · Reference# = webhook `ref` · Description = webhook `description`
   - Reporting tag "Head Office" = mapped from webhook `cost_center`

## How it runs
- Employee submits (web form or MS Form→Make→`/api` submit) → row created, stage = Manager.
- Each approver gets an email with `approve.html?id=N&role=...` → clicks Approve (can edit amount) → stage advances; everyone sees it live on the dashboard.
- Top-Management approval → `/api` posts to the Make webhook → Zoho expense created on Petty cash (head office) → dashboard shows **Posted**.

**DO NOT PRINT — SAVE PAPER.**
