# TDD evidence: kiryana loose goods and business-type modules

**Source plan**: none as a `*.plan.md`. The scope is the `/plan` of 2026-10-18 (kiryana first, modules per business type)
plus ADR-0003 and ADR-0008. Journeys below were written during this run.

## How strictly TDD was followed (honest summary)

| Part | Order actually followed |
|------|-------------------------|
| Desktop cart store, receipt model, `qtyStep`, `parseSignedQuantity`, `variantQtyText` | **Strict RED then GREEN.** Tests written first and run: they failed for the intended reasons, then the minimal code made them pass |
| `shared`, `core`, `db` (migration 0006, hash v2, modules, checkout, returns, purchasing, reports) | **Code first, tests after.** The new tests were written afterwards; the existing 538 tests were the safety net during the change (only the 8 tests that hard-coded "5 migrations" / "hashVersion 2 is unsupported" had to change, deliberately) |
| `lib/qty.ts` first four helpers (`qtyText`, `perUnit`, `labelFor`, `quickLabel`) | Code first; their tests pass immediately, so they are verification, not RED evidence |
| React components (Billing, Inventory, ReceiveStockDialog, Login, AppShell, router, Reports, Receipt) | No component tests: the desktop test environment is `node` with no jsdom / testing-library. Logic was moved into tested modules; the components are checked by typecheck and lint only. **Not yet clicked through in a browser** (a smoke test was attempted, but the Chrome extension was not connected) |
| Git checkpoint commits | **Not made.** The working tree already held about 27 uncommitted changes of the owner on `main`; committing would have bundled them. Commit when the owner decides |

## User journeys

1. As a kiryana cashier I sell 1.25 kg of sugar at Rs 285.50 per kg and the bill is exactly Rs 356.88.
2. As a kiryana cashier I type a weight or tap 250 g / 500 g / 1 kg, and scanning the same item again does not add a kilo.
3. As a customer I return 500 g and get the rounded share back; stock goes up by 500 g.
4. As the shop owner I receive a 25 kg bag at Rs 250/kg from a supplier and the payable is Rs 6,250.
5. As the vendor I give a kiryana shop only its modules: no phones, repairs or warranty (menu hidden, service refuses).
6. As an existing shop I upgrade without losing a single invoice or breaking the hash chain.

## Task report

| Task | Summary | Validation actually run | Result |
|------|---------|-------------------------|--------|
| Cart weights | Loose lines start at 1 kg, are edited in grams, discount is capped by the rounded gross, old held bills read as pieces | `npx vitest run --project @pos/desktop` | RED: `lineScale / lineGrossOf is not a function`, `expected 'added' to be 'weighed'`, `expected 1000000 to be 35688`. GREEN: 7 files, 85 tests passed |
| Receipt units | Items carry `unitScale` and `unitLabel` (variant label, else kg, phones always pcs) | same | RED: `expected undefined to be 'L'`, objects missing the unit fields. GREEN as above |
| Quantity helpers | `qtyStep`, `parseSignedQuantity` (no `-0`), `variantQtyText` | same | RED: `(0 , parseSignedQuantity) is not a function`. GREEN as above |
| Migration 0006 + hash v2 | Per-item scale, `sale_lines` rebuild, v1 hashes untouched | `npx vitest run --project @pos/db --project @pos/core --project @pos/shared` | 597 passed; `git diff` of `testdata/invoice-vectors.json` shows 228 added lines and 0 removed |
| Cross-engine | Same kiryana flow on sql.js (browser engine) | `npx vitest run --project @pos/desktop kiryana` | 2 passed |
| Whole project | typecheck, eslint, prettier, all tests | `npm run check` | exit 0, 35 test files, 684 tests passed |

## Test specification

| # | What is guaranteed | Test file | Type |
|---|--------------------|-----------|------|
| 1 | `quantity x price / scale` rounds half away from zero for sales and returns, never gives `-0` | `packages/shared/test/units.test.ts`, `packages/core/test/units.test.ts` | unit |
| 2 | Quantities format and parse exactly ("1.25", up to 3 decimals, pieces whole) | `packages/shared/test/units.test.ts`, `apps/desktop/test/qty.test.ts` | unit |
| 3 | Weighted lines are rejected when their total is wrong, a phone cannot be weighed, v1 invoices cannot carry weighted lines | `packages/shared/test/units.test.ts` | unit |
| 4 | Hash v1 ignores `unitScale` (stored hashes stay valid), v2 includes it, a chain may switch v1 to v2, editing a v2 unit is detected | `packages/core/test/units.test.ts`, `testdata` golden vectors | unit |
| 5 | Upgrading a database that already has invoices keeps every line and hash, verifies the chain, keeps `sale_lines` immutable | `packages/db/test/weighted-units.test.ts` | integration |
| 6 | The database refuses a wrong `line_total`, a line with a unit that differs from its variant, a mismatched label/scale, and a unit change once stock exists | `packages/db/test/weighted-units.test.ts` | integration |
| 7 | Kiryana flow end to end: sale, preview, discount, stock in grams, partial return, void, supplier purchase, reports, low stock, caps | `packages/db/test/service/weighted.test.ts` | integration |
| 8 | A shop gets only its modules; removing one takes effect at once; unknown type or unit is rejected; legacy shops keep everything | `packages/db/test/service/weighted.test.ts` | integration |
| 9 | Cart: pieces behave as before, loose goods start at 1 kg, rescan selects instead of adding, caps, rounded discount cap, grams in the draft, old held bills | `apps/desktop/test/cart.test.ts` | unit |
| 10 | Receipt model carries the unit and shows positive figures on returns | `apps/desktop/test/receipt-model.test.ts` | unit |
| 11 | Both SQLite engines (Node and sql.js) agree on migration, rounding, chain and module refusal | `apps/desktop/test/kiryana-sqljs.test.ts` | integration |

## Coverage and known gaps

`npx vitest run --coverage`: all files 98.6% statements, 93.85% branches, 98.98% functions. Lowest changed files:
`packages/db/src/service/modules.ts` 87% (the pass-through branch for non-function properties is never hit),
`meta.ts` 79% branches (settings parsing fallbacks that predate this work).

Intentional gaps: no component tests (see above); no Playwright run; batch and expiry are not built; the `?mock=1`
service in `apps/desktop/src/service/mock.ts` supports pieces only.

## Merge evidence

No checkpoint commits exist, so there is nothing to squash. Summary for a future commit message: RED on cart, receipt
model and quantity helpers; GREEN after minimal implementation; backend verified by the existing suite plus 100 new tests;
`npm run check` green.
