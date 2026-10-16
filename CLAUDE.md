# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Subscription-based **POS for mobile shops** (phones + accessories + repair) targeting the Pakistani local market. Sold per month to shopkeepers; the app must stop accepting sales when a subscription lapses. The owner (user) communicates in Roman Urdu — reply in Roman Urdu, keep code, identifiers and docs in English.

**Status (2026-10-11): Phase 1 mostly built.** `packages/shared`, `packages/core`, `packages/db` (SQLite schema + `PosService`) and `apps/desktop` (React UI, runs in the browser on sql.js) exist and pass `npm run check`. Not built yet: Tauri/Rust shell, ESC/POS printing, supplier ledger screen, and everything in Phases 2–4 (server, sync, licensing). See `PLAN.md` for exact ticks. The working copy is `C:\dev\point-of-sale`; the OneDrive copy is stale, and neither has any commits yet.

The full service catalogue (what we sell, per plan tier) and the phased roadmap live in `PLAN.md`:

@PLAN.md

## Environment (checked 2026-10-11)

Windows 10, Node v24.19.0, npm 11.17.0, git 2.55. **Rust/Cargo are NOT installed** — Tauri needs `rustup` (stable, MSVC toolchain) plus Visual Studio Build Tools (C++ workload) and WebView2. Install these before scaffolding the desktop app. Project folder is under OneDrive; keep `node_modules`, `target/` and SQLite files out of OneDrive sync (add to `.gitignore`, consider moving the working copy off OneDrive).

## Commands

From the repo root: `npm run check` (typecheck + eslint + prettier + vitest, run it before every commit), `npm test` (vitest run), `npm run typecheck`, `npm run lint`, `npm run format`, `npm run dev` (desktop UI via Vite). Demo scripts: `npx tsx scripts/demo.ts`, `npx tsx scripts/service-smoke.ts`.

Layout (npm workspaces monorepo; `apps/server`, `apps/admin`, `apps/owner-pwa` and `src-tauri` are still planned):

```
apps/desktop   Tauri 2 + React + TypeScript + Vite   (the POS the shopkeeper uses)
apps/server    NestJS + PostgreSQL                    (sync, licensing, billing, admin API)
apps/admin     React admin panel                      (owner-only: tenants, payments, extend subscription)
apps/owner-pwa React PWA                              (shop owner's remote reports; Phase 3)
packages/shared  Zod schemas / TS types shared by all apps
```

## Multi-agent workflow

Project subagents live in `.claude/agents/`. The user works with several agents in parallel, so file ownership is strict to avoid collisions:

| Agent | Owns | Model |
|---|---|---|
| `pos-architect` | Blueprints and the `packages/shared` contract (read-only agent; the main session writes what it specifies) | opus |
| `desktop-dev` | `apps/desktop/**` (except licence code) | sonnet |
| `backend-dev` | `apps/server/**`, `apps/admin/**` (except licence code) | sonnet |
| `license-guard` | Rust `license` module + server licence service | opus |
| `qa-tester` | Test files only; reports production bugs, never fixes them | sonnet |
| `pos-reviewer` | Read-only review against this file's rules | sonnet |

Order for a feature: `pos-architect` blueprint → implementers (desktop/backend/licence in parallel, each in their own folder) → `qa-tester` → `pos-reviewer` → commit. Agents must not edit outside their ownership; they report the needed change instead.

## Architecture decisions (do not re-litigate without asking)

1. **Desktop-first, offline-first, cloud-synced.** Shops have unreliable internet and power; a sale must never depend on the network. The POS reads/writes a local **SQLite** DB; a background sync engine pushes/pulls to the server when online. Pure-web POS was rejected (printer/scanner friction, outages stall the shop).
2. **Multi-tenant server** — every row carries `tenant_id`; PostgreSQL Row-Level Security enforces isolation.
3. **IDs are UUID v7** generated on the device, so offline records never collide.
4. **Sync uses an outbox table.** Local writes append to `outbox`; the sync worker drains it. Server returns changes by cursor.
5. **Stock is a ledger, not a number.** Quantity = sum of `stock_movements` rows (sale −n, purchase +n, return, adjustment). Never overwrite a stock count; this is what makes multi-device sync conflict-free.
6. **Sales are immutable.** No edit/delete of invoices — corrections are return/void entries. Invoices are hash-chained (each stores the previous invoice's hash) so deletion is detectable.
7. **Phones are tracked per unit by IMEI/serial**; accessories by SKU/barcode with variants (model/colour). Price and cost history is kept because phone rates move with the dollar.
8. **Money is stored as integer paisa** (PKR minor units), never floats.

## Subscription / licensing design (security-critical)

Threat model: an ordinary shopkeeper who stops paying or sets the PC clock back — not a skilled reverse engineer. Goal is to make cheating inconvenient, not impossible; avoid false locks on honest customers.

- Server issues an **Ed25519-signed license token** `{tenant_id, device_id, plan, valid_until, grace_days, max_offline_days, issued_at}`. Private key lives only on the server; the app embeds the public key and can verify but never mint tokens. Token is bound to a device fingerprint.
- **Verification lives in the Rust side of Tauri, not in JavaScript.** Check at app start, before every sale is committed, and when opening reports — not in a single place. Store the token encrypted with Windows DPAPI.
- **Never trust the system clock.** Trusted time = max of: persisted `last_seen`, latest `created_at` among local sales, last server-signed time anchor. If `system_now < trusted_floor - 5min` → clock tamper. `last_seen` is persisted in three places (SQLite, `%ProgramData%` file, registry), each HMAC-signed.
- **Offline usage budget independent of the clock:** token carries `max_offline_days` / max active hours; the app counts elapsed runtime since the last online verification. Exceeding it requires an online check.
- **States:** `TRIAL → ACTIVE → GRACE (3–5 days, daily warning) → LOCKED → SUSPENDED`. In `LOCKED`, creating sales/stock entries is blocked but existing data stays viewable/exportable (read-only). Payment → server issues new token → app unlocks itself on next online check.
- Server also rejects sync from expired tenants and cuts cloud extras (owner PWA, backup, WhatsApp reminders, updates).
- Provide an **emergency unlock code** (issued by the owner via WhatsApp, 1–2 days) and warn-before-lock on clock tamper, because a dead CMOS battery can legitimately skew the clock.
- Payments: Stripe is unavailable in Pakistan. Start **manual** (JazzCash / Easypaisa / bank transfer → owner clicks "extend" in the admin panel), automate later (Safepay / PayFast / JazzCash merchant API).

## Domain notes (mobile-shop specifics)

PTA status (approved / non-PTA / JV), new / used / open-box condition, trade-in of customer phones (record CNIC + IMEI to avoid stolen-phone liability), warranty by IMEI (shop vs company), installment (qist) plans with guarantor and due reminders, repair job tickets with spare-part consumption, easyload / scratch-card / JazzCash-Easypaisa agent registers, udhaar/khata ledgers for both customers and suppliers, Urdu + English receipts on 58 mm / 80 mm ESC/POS thermal printers.
