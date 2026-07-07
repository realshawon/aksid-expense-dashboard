# Gap Assessment — AKSID Expense vs. The App Development Standard

_Scope: the standard's **Security & Safety Baseline (§4)** and **Definition of Done (§1.1)**._
_Context: this is a small internal tool (one Vercel serverless function + Neon Postgres + Make.com +
static HTML). It is assessed proportionally — not every enterprise MUST is worth retrofitting, but the
security-baseline items below are._

Legend: **P0** = fix first (real exposure), **P1** = important, **P2** = completeness / polish.

---

## P0 — Security baseline, real exposure

### 1. Authorization is client-trusted (violates §4.3)
The approval page passes the approver's role in the URL (`approve.html?id=5&role=Audit`) and the API
trusts it. There is no authentication. Anyone who opens or guesses a link can act as **any** stage.
Sequential IDs (`1000000 + id`) make links guessable, and `Access-Control-Allow-Origin: *` lets any
site POST approvals.
**Fix (small, high impact):** issue a **signed, per-stage approval token** — `HMAC_SHA256(id + stage +
secret)` embedded in each email link. The API recomputes and constant-time compares it; the role is
derived from the verified token, never from a query param. This kills forgery and ID-walking in one
change and needs no login system. Tighten CORS to the app's own origin for state-changing actions.

### 2. Admin key has a hardcoded public default (violates §1.4 fail-closed, §4)
`ADMIN_KEY` falls back to the literal `'aksid-admin-2026'` when the env var is unset, so `resend` /
`setManager` / `unreject` are effectively open with a known key.
**Fix:** require `ADMIN_KEY` from env; if it is missing, **refuse** the privileged action (fail closed).
Remove the literal from source and set it as a Vercel env var + rotate it.

### 3. No rate limiting (violates §4.4)
No throttle on `approve` / `submit` / `resend`. Combined with guessable IDs, the surface is brute-forceable.
**Fix:** a lightweight per-IP/per-token limiter (even a short-window counter in Postgres/Neon) on the
mutating actions, returning `429 + Retry-After`.

---

## P1 — Important hardening

### 4. Audit trail is not tamper-evident (partial vs §4.1)
`history` is a plain JSONB array — append-style but editable, no hash chain, and it does not capture
IP / user-agent / verified actor.
**Fix:** hash-chain each history entry (`hash = SHA256(prevHash | canonical(entry))`) and record IP +
user-agent + the token-verified actor, so the record of "who approved what" can't be silently altered.

### 5. Weak actor identity / attribution (vs §4.1–4.2)
Because approvers aren't authenticated, the trail attributes actions to a role string, not a person.
**Fix:** the signed token (P0-1) already binds the intended approver mailbox; record that verified
identity on each action.

---

## P2 — Definition of Done / completeness (§1.1)

- **List operations:** dashboard caps at 200 rows with no server-side **search / filter / sort /
  pagination**, and no **export**. A real operator will outgrow this quickly.
- **Lifecycle:** there's create → approve/reject (+ unreject), but no **edit/correct** a submitted
  expense and no **delete/archive**. "Complete lifecycle" wants both, with undo on destructive actions.
- **Owner drill-down (§1.2):** the dashboard is read-only totals; the standard wants per-number
  drill-down for the owner.
- **State coverage:** the approval page handles already-approved / not-your-turn / posted / rejected
  well; submit + dashboard still need fuller **empty / error + recovery** states.
- **Observability (§10):** no request-id correlation, structured logs, or RED metrics.
- **i18n / a11y (§8–§9):** UI is ad-hoc English; no formal accessibility or localization pass.

---

## Already aligned (recent work)

- Self-healing schema (auto-repair + retry) — aligns with §7 reliability.
- Outgoing payload **firewall** + fail-closed skip on bad recipients — aligns with §1.4 / §5 prevention.
- Retry-with-backoff on Make/Zoho; approval still succeeds if a side-channel fails (never lost).
- `/health` self-check + scheduled daily monitor — aligns with §10 observability/ops.

## Recommended order
**P0-2 (admin key)** → **P0-1 (signed approval tokens + CORS)** → **P0-3 (rate limit)** →
**P1-4/5 (tamper-evident, attributed audit)** → then P2 completeness as the tool grows.
