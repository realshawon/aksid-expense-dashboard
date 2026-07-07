# Standards — AKSID Expense

This folder carries the engineering rulebook with the code, per the standard's own instruction
("copy it into every new repository at `docs/standards/` so the rules travel with the code").

- **APP_DEVELOPMENT_STANDARD.md** — the portable engineering, security, and process standard. This is
  the authoritative rulebook for how anything here is built, secured, tested, and shipped. MUST/SHOULD
  language applies.
- **GAP_ASSESSMENT.md** — how this specific app currently measures against the standard's security
  baseline and Definition of Done, with a ranked, do-this-first list.

The `.docx` / `.pdf` source of the standard live alongside as the canonical originals.

> This app is a small internal tool (single serverless function + Neon Postgres + Make.com), so it does
> not match the standard's full reference stack (NestJS monorepo, etc.). The standard is applied
> **proportionally**: full rigor on anything new; pragmatic, risk-ranked hardening on the existing tool.
