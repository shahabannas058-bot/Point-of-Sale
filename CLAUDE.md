# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Subscription-based **multi-business POS** for the Pakistani local market: one product and one installer sold to **kiryana/grocery stores (first target business type), mobile shops and laptop shops**. Each shop only gets the modules enabled for its business type (see "Business types and modules"). Sold per month to shopkeepers; the app must stop accepting sales when a subscription lapses. The owner (user) communicates in Roman Urdu — reply in Roman Urdu, keep code, identifiers and docs in English.

**Decisions of 2026-10-18 (made by the owner):** the desktop shell is the C# WPF + WebView2 app in `apps/shell-dotnet` (ADR-0010, 2026-10-18, supersedes the same day's Tauri choice); the server is **C# / ASP.NET Core on .NET 10 + PostgreSQL** (replaces the earlier NestJS plan); the admin panel is **React**; the **first business type to ship is kiryana**, mobile shop second; the server/admin contract is **OpenAPI** (no API key involved — it is a spec file, not a service).

**Phase 1b built (2026-10-18):** migration 0006 (per-item unit scale, `sale_lines` rebuilt, hash v2), business types + modules (`MODULE_PRESETS`, `MODULE_DISABLED` guard on `imei` / `repair` / `warranty` / `weight_units` inside `PosService`), kg / litre entry in billing, inventory, receive-stock and receipts, a business-type choice in the setup wizard, module-aware menu and routes. `npm run check` is green with 682 tests; the kiryana flow is also tested on sql.js. **Not built yet for kiryana:** WhatsApp reminders, ESC/POS printing. Batch + expiry is built (migration 0007, ADR-0009). Kiryana demo data exists (`seedDemoData(deps, { businessType: 'kiryana' })`; the first-load auto-seed in `service/real.ts` loads the kiryana demo). The desktop `service/mock.ts` (`?mock=1`) was deleted on 2026-10-18: the real service on sql.js is the only dev path.

**Status (2026-10-11): Phase 1 mostly built (mobile-shop flavoured).** `packages/shared`, `packages/core`, `packages/db` (SQLite schema + `PosService`) and `apps/desktop` (React UI, runs in the browser on sql.js) exist and pass `npm run check`. Also built: supplier khata screens, repair job tickets and IMEI warranty (migration 0005, `repairs`/`warranty` APIs, screens), a liquid-glass UI, and the app's `ur` language is **Roman Urdu** (Latin letters, LTR; the id stays `ur`). Not built yet: ESC/POS printing, trade-in, easyload/agent registers, and everything in Phases 2–4 (server, sync, licensing). See `PLAN.md` for exact ticks. The working copy is `C:\dev\point-of-sale`; the OneDrive copy is stale, and neither has any commits yet.

The full service catalogue (what we sell, per plan tier) and the phased roadmap live in `PLAN.md`:

@PLAN.md

## Environment (checked 2026-10-11)

Windows 10, Node v24.19.0, npm 11.17.0, git 2.55, .NET SDK 10.0.402 (checked 2026-10-18; server targets `net10.0`). The desktop shell (`apps/shell-dotnet`) needs only the .NET SDK and the WebView2 runtime (155.x installed). Rust/Cargo and the Visual Studio Build Tools are **not installed and no longer needed** (ADR-0010). Build the shell with `npm run build -w @pos/desktop` then `dotnet build apps/shell-dotnet/PosShell.App`; set `POS_DATA_DIR` to a scratch folder to try it without touching real shop data. The build output goes to `bin/` and `obj/`, which eslint does not ignore yet: delete them before `npm run check`, or add `**/bin/**` and `**/obj/**` to the ignores in `eslint.config.js`. Project folder is under OneDrive; keep `node_modules`, `target/` and SQLite files out of OneDrive sync (add to `.gitignore`, consider moving the working copy off OneDrive).

## Commands

From the repo root: `npm run check` (typecheck + eslint + prettier + vitest, run it before every commit), `npm test` (vitest run), `npm run typecheck`, `npm run lint`, `npm run format`, `npm run dev` (desktop UI via Vite). Demo scripts: `npx tsx scripts/demo.ts`, `npx tsx scripts/service-smoke.ts`.

Layout (npm workspaces monorepo; `apps/server`, `apps/admin` and `apps/owner-pwa` are still planned; `apps/server` and `apps/shell-dotnet` are .NET solutions, not npm workspaces):

```
apps/desktop   React + TypeScript + Vite              (the POS UI; runs in a browser for development, inside the shell for shops)
apps/shell-dotnet  C# WPF + WebView2 (net10.0)        (the Windows app: native pos.db, daily backup, bridge, later licence + printing)
apps/server    ASP.NET Core (net10.0) + EF Core + PostgreSQL  (sync, licensing, billing, admin API)
apps/admin     React + TypeScript admin panel         (owner-only: tenants, payments, extend subscription)
apps/owner-pwa React PWA                              (shop owner's remote reports; Phase 3)
packages/shared  Zod schemas / TS types shared by desktop, admin and owner-pwa
packages/api-client  TS client generated from the server's OpenAPI spec (planned)
```

**Contract between C# and TypeScript:** the server publishes an OpenAPI document; `packages/api-client` is generated from it (openapi-typescript or NSwag) and is never hand-edited. Rules that exist on both sides (invoice hash chain, stock ledger, money) are kept in sync with **shared JSON test vectors** that both the vitest and the .NET test suites run.

## Multi-agent workflow

Project subagents live in `.claude/agents/`. The user works with several agents in parallel, so file ownership is strict to avoid collisions:

| Agent | Owns | Model |
|---|---|---|
| `pos-architect` | Blueprints and the `packages/shared` contract (read-only agent; the main session writes what it specifies) | opus |
| `desktop-dev` | `apps/desktop/**` (except licence code) | sonnet |
| `backend-dev` | `apps/server/**` (C#/.NET), `apps/admin/**` (React) (except licence code) | sonnet |
| `license-guard` | Licence verifier in `apps/shell-dotnet` (C#) + server licence service | opus |
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
7. **Phones are tracked per unit by IMEI/serial** (module `imei`); accessories by SKU/barcode with variants (model/colour). Price and cost history is kept because phone rates move with the dollar.
8. **Money is stored as integer paisa** (PKR minor units), never floats.
9. **Server is C# / ASP.NET Core (net10.0) + EF Core + PostgreSQL** (decided 2026-10-18, supersedes NestJS). Tenant isolation: `tenant_id` on every row, RLS enforced by setting `app.tenant_id` per connection in an EF Core interceptor. Ed25519 via `NSec.Cryptography` (.NET has no built-in Ed25519).
10. **One product, per-tenant modules.** A tenant has a `business_type` (kiryana / mobile / laptop / custom) and a `modules[]` list. Modules are carried in the signed licence token and enforced inside `PosService`, not just by hiding menu items.
11. **Quantities are whole numbers in the item's base unit** — pieces, or grams / millilitres — never floats. Each accessory variant has `unit_scale` (1 = piece, 1000 = kg / litre) and `unit_label` (`pcs` / `kg` / `L`); prices (sale, cost, `unit_price`) are per priced unit (per piece, per kg). `line_total = round_half_away_from_zero(qty × price ÷ scale) − discount`, the same rule in `lineGross()` (TS), the `sale_lines` CHECK and reports SQL, and the C# port. The unit is locked once a variant has stock movements. Phones are always pieces. Invoices have `hash_version` 2, which hashes each line's `unitScale`; v1 invoices stay valid forever. See ADR-0008 (supersedes ADR-0005's global milli-units, which would have rewritten hashed invoices).
12. **Admin panel is React + TypeScript**, talking to the .NET API through the generated `packages/api-client`.

## Subscription / licensing design (security-critical)

Threat model: an ordinary shopkeeper who stops paying or sets the PC clock back — not a skilled reverse engineer. Goal is to make cheating inconvenient, not impossible; avoid false locks on honest customers.

- Server issues an **Ed25519-signed license token** `{tenant_id, device_id, plan, business_type, modules[], valid_until, grace_days, max_offline_days, issued_at}`. Private key lives only on the server; the app embeds the public key and can verify but never mint tokens. Token is bound to a device fingerprint.
- **Verification lives in the C# desktop host (`apps/shell-dotnet`), not in JavaScript** (ADR-0010, was Rust in ADR-0004). Check at app start, before every sale is committed, and when opening reports — not in a single place. Because sales are written by the TypeScript `PosService` through the bridge's `db.batch`, that call is the choke point: the host must refuse writes to sales and stock when the licence is not valid. Store the token encrypted with Windows DPAPI.
- **Never trust the system clock.** Trusted time = max of: persisted `last_seen`, latest `created_at` among local sales, last server-signed time anchor. If `system_now < trusted_floor - 5min` → clock tamper. `last_seen` is persisted in three places (SQLite, `%ProgramData%` file, registry), each HMAC-signed.
- **Offline usage budget independent of the clock:** token carries `max_offline_days` / max active hours; the app counts elapsed runtime since the last online verification. Exceeding it requires an online check.
- **States:** `TRIAL → ACTIVE → GRACE (3–5 days, daily warning) → LOCKED → SUSPENDED`. In `LOCKED`, creating sales/stock entries is blocked but existing data stays viewable/exportable (read-only). Payment → server issues new token → app unlocks itself on next online check.
- Server also rejects sync from expired tenants and cuts cloud extras (owner PWA, backup, WhatsApp reminders, updates).
- Provide an **emergency unlock code** (issued by the owner via WhatsApp, 1–2 days) and warn-before-lock on clock tamper, because a dead CMOS battery can legitimately skew the clock.
- Payments: Stripe is unavailable in Pakistan. Start **manual** (JazzCash / Easypaisa / bank transfer → owner clicks "extend" in the admin panel), automate later (Safepay / PayFast / JazzCash merchant API).

- **Onboarding a shop:** owner creates the tenant in the admin panel (business type + modules + plan) → server generates a one-time **activation code** → installer asks for the code on first run → device binds, token is downloaded and stored via DPAPI.
- **Remote visibility:** the admin panel shows per tenant: last payment, `valid_until`, state, `last_seen`, app version. "Extend" issues a fresh token; the POS unlocks itself on its next online check (offline shops use the emergency code or a token file import).

## Business types and modules

| Business type | Modules (preset, adjustable per tenant) |
|---|---|
| `kiryana` (**first to ship**) | core billing, khata/udhaar, suppliers, `weight_units` (kg/g, loose items), `batch_expiry`, barcode, low-stock |
| `mobile` | core + `imei`, `warranty`, `repair`, `tradein`, `easyload`, `agent_register`, `installment` |
| `laptop` | core + serial per unit (`imei` module reused as serial tracking), `warranty`, `repair`, spec variants |

`core` (billing, stock ledger, returns, khata, reports, users) is always on. Each module has its own tables/screens/service methods; a call to a module the tenant does not own is rejected by `PosService`.

## Domain notes (kiryana specifics — first business type)

Loose items sold by weight (kg/g, 250 g / 500 g steps), packed goods by barcode, expiry/batch for dairy and packaged food, very high number of small sales per day (billing speed matters most), heavy udhaar/khata use with monthly settlement, supplier/wholesaler credit, price changes from wholesalers, Urdu item names on receipts, low-stock alert before the weekly wholesale run.

## Domain notes (mobile-shop specifics, second business type)

PTA status (approved / non-PTA / JV), new / used / open-box condition, trade-in of customer phones (record CNIC + IMEI to avoid stolen-phone liability), warranty by IMEI (shop vs company), installment (qist) plans with guarantor and due reminders, repair job tickets with spare-part consumption, easyload / scratch-card / JazzCash-Easypaisa agent registers, udhaar/khata ledgers for both customers and suppliers, Urdu + English receipts on 58 mm / 80 mm ESC/POS thermal printers.
