# PLAN.md — Mobile Shop POS

Tick boxes as work completes. Architecture rules and licensing design are in `CLAUDE.md`.

## 1. Services we sell

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
- [ ] Full keyboard billing (F-key / Ctrl shortcuts for save, print, delete row, customer, ledger, item history)
- [ ] Info at the till: item stock, last purchase price, customer balance, last rate sold to this customer
- [ ] Item history / stock register (every in/out movement per item)
- [ ] Reorder level per item with low-stock list and purchase suggestion

### Standard
- [ ] Multiple users with roles (owner / manager / cashier); cashier cannot discount or void without PIN
- [ ] Supplier purchases, supplier payable ledger, purchase returns
- [ ] Expense tracking, cash-in-hand / day close
- [ ] **Warranty tracking by IMEI** (shop vs company warranty, expiry lookup)
- [ ] **Trade-in / purchase of used phones** (CNIC + IMEI capture, goes back to stock)
- [ ] **Repair job tickets** (received → in repair → ready → delivered), advance payment, spare-part stock consumption
- [ ] Easyload / recharge / scratch-card register and commission
- [ ] JazzCash / Easypaisa agent transaction register
- [ ] WhatsApp invoice / reminder sending
- [ ] Audit log (who changed/deleted what)
- [ ] Purchase orders to suppliers; supplier rate comparison at purchase entry
- [ ] Quotations / sales orders (convert to invoice)
- [ ] Stock taking: physical count vs system stock, variance report, posted as adjustment movements
- [ ] Customer credit limit (warn/block on khata sale over limit)
- [ ] Rack / shelf location per item
- [ ] Fast-moving, slow-moving and dead-stock reports
- [ ] Multi-PC LAN mode (2–3 counters in one shop sharing one database)

### Pro
- [ ] **Installment (qist) system**: advance, monthly plan, guarantor, due-date WhatsApp reminders, overdue report
- [ ] Multi-branch with consolidated reports and stock transfer between branches
- [ ] Owner remote dashboard (PWA): live sales, stock, khata from phone
- [ ] Cloud backup (automatic, encrypted)
- [ ] Price/cost history and dollar-rate based repricing
- [ ] Staff commission / attendance
- [ ] Multiple godowns (warehouses) with stock transfer between them
- [ ] Reorder forecast from past sales (daily average × lead time)
- [ ] General ledger: chart of accounts, journal / payment / receipt vouchers, P&L and balance sheet
- [ ] FBR POS integration (Tier-1 retailers) — later
- [ ] Payment QR (JazzCash / Easypaisa) — later

### Included with every plan
Free setup + training, Urdu WhatsApp support, in-app updates, subscription reminders (7/3/1 days before expiry).

## 2. Platform / vendor-side services (owner's back office)

- [ ] Tenant, device and subscription management
- [ ] License token issuing service (Ed25519), trial → active → grace → locked → suspended
- [ ] Admin panel: add shop, record manual payment, extend subscription, issue emergency unlock code, view last-seen / app version
- [ ] Payment recording, invoices to shopkeepers, renewal reminders (WhatsApp/SMS)
- [ ] Sync API (push/pull by cursor), rejects expired tenants
- [ ] Automated payment gateway (Safepay / PayFast / JazzCash) — later
- [ ] Monitoring (Sentry, uptime) and encrypted DB backups

## 3. Roadmap

### Phase 0 — Setup
- [ ] Install Rust (rustup, MSVC), VS Build Tools C++ workload, WebView2 — _rustup done (on D:); **VS Build Tools still missing, blocks `cargo build`/Tauri**_
- [x] `git init`, `.gitignore`, root `package.json` with npm workspaces
- [x] TypeScript, ESLint/Prettier, Vitest config
- [x] Decide DB access layer for SQLite (`SqlDriver` abstraction in `packages/db`, SQL migrations 0001–0004)

### Phase 1 — Working offline POS (no licensing yet)
- [ ] Tauri shell — _React + Vite UI is built and runs in the browser on sql.js; the Tauri wrapper (native SQLite, `src-tauri`) is not scaffolded yet_
- [x] SQLite schema + migrations, money in integer paisa
- [x] Products: phones (IMEI units) and accessories (SKU/barcode/variants)
- [x] Stock ledger (`stock_movements`), purchase entry
- [x] Billing screen, payments (cash / khata / split), hash-chained immutable invoices
- [x] Returns / voids as entries
- [ ] Thermal receipt printing (ESC/POS), Urdu text rendering check — _browser `window.print()` receipt exists; ESC/POS encoder pending_
- [ ] Customer + supplier khata — _customer khata done; supplier payment/ledger screen pending_
- [x] Daily report, user login with roles
- [x] Tests for money math, stock ledger, invoice hash chain (493 tests, `npm run check` green)

### Phase 2 — Cloud, sync and licensing
- [ ] NestJS + PostgreSQL (RLS multi-tenant), auth
- [ ] Outbox sync engine (device ↔ server), UUID v7 ids
- [ ] License service + Rust verifier in Tauri, clock guard (`last_seen` ×3, sales floor, offline budget)
- [ ] Lock screen, grace warnings, read-only mode, emergency unlock code
- [ ] Admin panel (manual payment → extend)
- [ ] Trial flow for new shops

### Phase 3 — Mobile-shop depth
- [ ] Warranty, trade-in, repair tickets, easyload/agent registers
- [ ] Installment (qist) system with reminders
- [ ] WhatsApp integration, owner PWA, cloud backup

### Phase 3b — Competitor parity (gaps vs Abuzar / WASILA, researched 2026-10-17)
- [ ] Keyboard shortcut map + till info panel (stock, last cost, customer balance, last rate)
- [ ] Item history / stock register, reorder levels + purchase suggestion
- [ ] Purchase orders, quotations / sales orders, supplier rate comparison
- [ ] Stock taking with variance report, rack locations, customer credit limit
- [ ] Fast / slow / dead-stock reports
- [ ] Multi-PC LAN mode, multiple godowns, general ledger + vouchers

### Phase 3c — Multi-niche (one product, many shop types)
- [ ] Refactor into core + niche modules; "business type" chosen at shop setup turns modules on/off
- [ ] Move mobile-only features (IMEI, PTA, repair, qist, warranty) into a `mobile` module
- [ ] `pharmacy` module: batch + expiry, pack / strip / tablet units, manufacturer, near-expiry report
- [ ] `grocery` module: sale by weight (kg / g), loose items, barcode-scale labels

### Phase 4 — Growth
- [ ] Payment gateway automation, multi-branch ,FBR, installer + auto-update, code signing

## 4. Open questions for the owner
- Confirm the working folder may move off OneDrive (sync conflicts with `node_modules`/SQLite).
- Plan prices (draft only): Basic ~Rs 1,500–2,500, Standard ~Rs 3,500–5,000, Pro ~Rs 6,000+ per month — verify against local competitors before publishing.
- Trial length (7 vs 14 days) and grace length (3 vs 5 days).
