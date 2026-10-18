# PLAN.md — Multi-business POS (kiryana first, then mobile and laptop shops)

Tick boxes as work completes. Architecture rules and licensing design are in `CLAUDE.md`.

**Order of business types (decided 2026-10-18):** 1) kiryana/grocery, 2) mobile shop (largely built already), 3) laptop shop. One codebase; each shop gets only its modules via the signed licence token.

## 1. Services we sell

### Kiryana / grocery module set (first to ship)
- [x] Exact kg / litre arithmetic: per-item unit scale, quantities in grams / ml, migration 0006 (ADR-0008, replaces the milli-units idea)
- [x] Loose items sold by weight (kg / g), price per kg, quick weight buttons (250 g / 500 g / 1 kg)
- [ ] Packed goods by barcode — _barcode scan exists; the keyboard-first flow for very high sales volume is still to tune_
- [x] Batch + expiry tracking, near-expiry report — _migration 0007, first-expiry-first-out sales, expired stock never sold, returns go back to their batch, write-off, Expiry screen, batch fields in Receive stock (ADR-0009)_
- [ ] Customer khata with monthly settlement and WhatsApp reminder — _khata exists; monthly settlement view and WhatsApp pending_
- [x] Wholesaler/supplier credit ledger (reuses the supplier khata screens)
- [ ] Urdu item names on receipts — _item names are free text; Urdu rendering check is pending with ESC/POS_
- [x] Kiryana preset: modules `weight_units`, `batch_expiry`; hides IMEI / repair / warranty screens and blocks them in `PosService`
- [x] Kiryana demo data for "Load demo data" (`seedDemoData(deps, { businessType: 'kiryana' })`, 19 items, khata, wholesaler credit; the setup wizard passes the chosen type)

### Basic (entry plan)
- [ ] Fast billing with barcode scan, hold/resume bill, discounts
- [ ] Phone inventory with **IMEI/serial per unit**, PTA status, new/used/open-box
- [ ] Accessories inventory with barcode, variants (model, colour), low-stock alert
- [ ] Urdu + English receipt, 58 mm / 80 mm thermal print, A4 invoice
- [ ] Customer **khata / udhaar** ledger (take & give payments)
- [ ] Daily sales, profit and stock reports
- [ ] Returns / exchange / void (as new entries, never edits)
- [ ] Offline operation (full functionality without internet)
- [ ] Local backup + restore, Excel import of existing stock

### Standard
- [ ] Multiple users with roles (owner / manager / cashier); cashier cannot discount or void without PIN
- [ ] Supplier purchases, supplier payable ledger, purchase returns
- [ ] Expense tracking, cash-in-hand / day close
- [x] **Warranty tracking by IMEI** (shop vs company warranty, expiry lookup)
- [ ] **Trade-in / purchase of used phones** (CNIC + IMEI capture, goes back to stock)
- [x] **Repair job tickets** (received → in repair → ready → delivered), advance payment, spare-part stock consumption
- [ ] Easyload / recharge / scratch-card register and commission
- [ ] JazzCash / Easypaisa agent transaction register
- [ ] WhatsApp invoice / reminder sending
- [ ] Audit log (who changed/deleted what)

### Pro
- [ ] **Installment (qist) system**: advance, monthly plan, guarantor, due-date WhatsApp reminders, overdue report
- [ ] Multi-branch with consolidated reports and stock transfer between branches
- [ ] Owner remote dashboard (PWA): live sales, stock, khata from phone
- [ ] Cloud backup (automatic, encrypted)
- [ ] Price/cost history and dollar-rate based repricing
- [ ] Staff commission / attendance
- [ ] FBR POS integration (Tier-1 retailers) — later
- [ ] Payment QR (JazzCash / Easypaisa) — later

### Included with every plan
Free setup + training, Urdu WhatsApp support, in-app updates, subscription reminders (7/3/1 days before expiry).

## 2. Platform / vendor-side services (owner's back office)

- [ ] Tenant, device and subscription management (business type + modules per tenant)
- [ ] License token issuing service (Ed25519 via NSec, token carries `modules[]`), trial → active → grace → locked → suspended
- [ ] Activation code flow: admin creates shop → one-time code → installer binds the device
- [ ] Admin panel (React): add shop, record manual payment, extend subscription, suspend, issue emergency unlock code, view last-seen / app version, paid/unpaid overview
- [ ] Payment recording, invoices to shopkeepers, renewal reminders (WhatsApp/SMS)
- [ ] Sync API (push/pull by cursor), rejects expired tenants
- [ ] Automated payment gateway (Safepay / PayFast / JazzCash) — later
- [ ] Monitoring (Sentry, uptime) and encrypted DB backups

## 3. Roadmap

### Phase 0 — Setup
- [x] Desktop toolchain — _no longer needs Rust or VS Build Tools: the shell is C# (ADR-0010); .NET SDK 10.0.402 and the WebView2 runtime are installed_
- [x] .NET SDK for the server — _10.0.402 already installed (2026-10-18)_
- [x] ADR log in `docs/adr/` — _8 ADRs written 2026-10-18 (offline-first, .NET backend, per-tenant modules, Rust licence verify, milli-units → superseded by per-item unit scale, OpenAPI contract, Tauri); add a new ADR for every future architecture decision_
- [x] `git init`, `.gitignore`, root `package.json` with npm workspaces
- [x] TypeScript, ESLint/Prettier, Vitest config
- [x] Decide DB access layer for SQLite (`SqlDriver` abstraction in `packages/db`, SQL migrations 0001–0004)

### Phase 1 — Working offline POS (no licensing yet)
- [x] Desktop shell — _C# WPF + WebView2 in `apps/shell-dotnet` (ADR-0010 replaces Tauri). Verified 2026-10-18 on a scratch data folder: setup wizard on an empty native `pos.db`, demo load, login, Expiry screen and a real sale with batches all work through the bridge. Still to do: installer / auto-update, ESC/POS printing, fix the 2 old C# test problems, licence guard on `db.batch`_
- [x] SQLite schema + migrations, money in integer paisa
- [x] Products: phones (IMEI units) and accessories (SKU/barcode/variants)
- [x] Stock ledger (`stock_movements`), purchase entry
- [x] Billing screen, payments (cash / khata / split), hash-chained immutable invoices
- [x] Returns / voids as entries
- [ ] Thermal receipt printing (ESC/POS), Urdu text rendering check — _browser `window.print()` receipt exists; ESC/POS encoder pending_
- [x] Customer + supplier khata — _customer khata and supplier ledger/payment screens done_
- [x] Daily report, user login with roles
- [x] Tests for money math, stock ledger, invoice hash chain (536 tests, `npm run check` green)

### Phase 1b — Multi-business core + kiryana (next; can run in parallel with Phase 2a)
- [x] Migration 0006: per-item unit scale (kg / L), `sale_lines` rebuilt, hash v2; `business_type` + `modules` live in `app_meta` (the licence token will write them) — batch/expiry tables still to do
- [x] Modules registry + guard inside `PosService` (module not owned → `MODULE_DISABLED`); presets per business type; module-aware menu and routes
- [x] Responsive UI and window fit (2026-10-18): no page-level overflow from 1920 down to 360 px; below 640 px the menu is a bottom bar that scrolls sideways, the top bar wraps and the cart becomes cards; the desktop window opens inside the screen's work area (`WindowFit`, min size 360 x 480) so its title bar with minimize / maximize / close is never cut off. Checked with screenshots in the real shell; there are no automated layout tests
- [ ] Kiryana screens: weight entry ✓ (billing, inventory, receive stock, receipt); batch/expiry ✓ (receive stock, Expiry screen); kiryana-first billing layout and shortcuts still to do
- [x] Tests: rounding and unit math, module guard, hash v1→v2 chain, migration upgrade, kiryana flow on Node SQLite and sql.js (`npm run check` green, 682 tests)

### Phase 2a — .NET server and admin (parallel with 1b)
- [ ] `apps/server`: ASP.NET Core (net10.0) solution (Api / Domain / Infrastructure), EF Core + PostgreSQL, RLS via `app.tenant_id` interceptor, auth
- [ ] Tenants, devices, subscriptions, payments tables; licence issuer (NSec Ed25519) incl. `modules[]`
- [ ] OpenAPI spec published; `packages/api-client` generated; shared JSON test vectors for hash chain / ledger
- [ ] `apps/admin` (React): tenant list, record payment, extend, suspend, emergency code, last seen
- [ ] Trial flow for new shops, activation code flow

### Phase 2b — Cloud, sync and licensing on the device
- [ ] Outbox sync engine (device ↔ server), UUID v7 ids, server-side hash-chain verification
- [ ] Licence verifier in the C# shell (NSec Ed25519 + DPAPI, enforced at the bridge's `db.batch`), clock guard (`last_seen` ×3, sales floor, offline budget)
- [ ] Lock screen, grace warnings, read-only mode, emergency unlock code

### Phase 3 — Mobile-shop depth
- [ ] Warranty, trade-in, repair tickets, easyload/agent registers — _warranty + repair tickets done (migration 0005, service, screens); trade-in and easyload/agent registers pending_
- [ ] Installment (qist) system with reminders
- [ ] WhatsApp integration, owner PWA, cloud backup

### Phase 4 — Growth
- [ ] Payment gateway automation, multi-branch ,FBR, installer + auto-update, code signing

## 4. Open questions for the owner
- Confirm the working folder may move off OneDrive (sync conflicts with `node_modules`/SQLite).
- Plan prices (draft only): Basic ~Rs 1,500–2,500, Standard ~Rs 3,500–5,000, Pro ~Rs 6,000+ per month. Competitor snapshot (public web, 2026-10-18, re-verify before publishing): BazaarMint Rs 999/mo (14-day trial), SadaPOS Rs 1,199 / 2,399 / 4,599 per month with a free plan, Switcher Techno demo-only pricing. The draft prices sit above the cheap end of the market, so differentiation must be reliability, local setup/training and Urdu support.
- Laptop-shop module set: confirm what it needs beyond serial tracking, warranty and repair (spec variants, trade-in?).
- Apify (optional, not part of the product): lead lists of kiryana/mobile/laptop shops per city, and a weekly competitor-price check.
- Trial length (7 vs 14 days) and grace length (3 vs 5 days).
