# TDD evidence: kiryana demo data

Date: 2026-10-18. Runner: vitest through npm (`npx vitest run …`, `npm run check`).

## Source plan

No `*.plan.md`. The journey comes from the previous session's "Exact Next Step" (kiryana demo data in
`packages/db/src/service/seed.ts`, seed test first).

## User journey

As a kiryana shopkeeper trying the app, I press "Load demo data" in the setup wizard and get a ready grocery shop
(loose goods per kg / litre, packed goods with barcodes, khata customers, wholesaler credit, a few low-stock items),
so that I can learn the billing screen without typing a catalogue. Phones, repairs and warranty must not appear.

## Task report

| Task | Summary | Validation command | Result |
| ---- | ------- | ------------------ | ------ |
| `seedDemoData(deps, { businessType: 'kiryana' })` | New optional argument; `'kiryana'` creates a grocery shop through the real service (`seed-kiryana.ts`); no argument keeps the mobile-shop demo. Shared helpers moved to `seed-common.ts`. | `npx vitest run packages/db/test/service/seed-kiryana.test.ts` | RED then GREEN |
| Desktop wiring | `AppRuntime.loadDemo(businessType?)`; the wizard passes the chosen type; "Reset demo data" now reseeds the shop's own type (it used to always load the mobile demo). | `npm run check` (typecheck only; no component tests exist, see gaps) | PASS |

### RED (before `seed.ts` changed)

`npx vitest run packages/db/test/service/seed-kiryana.test.ts` → `Tests 4 failed | 5 passed (9)`:

- shop was not kiryana (`expected { …(8) } to match object { isDemo: true, … }`)
- `expected 0 to be greater than or equal to 6` (no loose goods)
- `expected 0 to be greater than or equal to 1` (no weighed sale line)
- `Expected a ServiceError but the call succeeded` (repairs were not blocked)

The extra `{ businessType }` argument was silently ignored, so the mobile demo was loaded: a failure caused by the
missing feature, not by setup. One test first failed for a wrong reason (my query used a table called `variants`; the
table is `accessory_variants`), fixed before the RED above. A second test had a wrong field path (`i.unitScale` instead of
`i.variant.unitScale`), found only at GREEN; it still fails against the old mobile seed, which has no 1000-scale item.

### GREEN

`npx vitest run packages/db/test/service/seed-kiryana.test.ts packages/db/test/service/seed.test.ts` →
`Test Files 2 passed (2) | Tests 18 passed (18)`.

Full gate: `npm run check` → exit 0, `Test Files 36 passed (36) | Tests 693 passed (693)`
(typecheck, eslint, prettier, vitest). Prettier needed one `--write` on the new file.

## Test specification

| # | What is guaranteed | Test (`packages/db/test/service/seed-kiryana.test.ts`) | Type | Result |
| - | ------------------ | ------------------------------------------------------ | ---- | ------ |
| 1 | Shop is a demo shop, `businessType` kiryana, modules equal `MODULE_PRESETS.kiryana`, 0 phones, 15+ items, 4+ customers, 2+ suppliers, three users | creates a demo shop that is a kiryana shop… | integration | PASS |
| 2 | 6+ loose items (grams / ml, both kg and L) and 8+ packed items, every packed item has a barcode, all have stock, no phones | stocks loose goods per kg / litre… | integration | PASS |
| 3 | At least 2 items are at or below their reorder level | has a few low-stock items… | integration | PASS |
| 4 | Invoice count equals the summary, hash chain verifies, integrity checks are 0, at least one line weighs a non-whole kg | has sample sales including a weighed line… | integration | PASS |
| 5 | A customer owes khata money and a supplier is owed money | has a customer with an open khata balance… | integration | PASS |
| 6 | Repairs are refused with `MODULE_DISABLED` | still refuses mobile-shop features… | integration | PASS |
| 7 | Two kiryana seeds give identical SKUs, barcodes and device id | is deterministic… | integration | PASS |
| 8 | A second kiryana seed throws `ALREADY_SETUP` | a second kiryana seed throws ALREADY_SETUP | integration | PASS |
| 9 | No option still loads the mobile demo (12 phones, business type custom) | the default seed is still the mobile shop | regression | PASS |

Tests 3, 5, 7 and 8 already passed against the old code (the mobile demo also has low-stock items and khata balances,
is deterministic and refuses a second seed). They guard behaviour that must not regress; the new behaviour is proven by
1, 2, 4 and 6.

## Coverage and known gaps

`npx vitest run … --coverage --coverage.include="packages/db/src/service/seed*.ts"`: seed-common 100 % stmts / 91.7 % branches,
seed-kiryana 100 % / 90.9 %, seed.ts 100 % / 80.6 %.

Gaps:

- The desktop wiring (`real.ts`, `Login.tsx`) has typecheck only. The desktop tests run in `environment: 'node'` with
  `.ts` files; there is no component or browser test, and the browser itself has not been driven (the Chrome extension was
  not connected in the previous session). `resetDemo` keeping the business type is therefore unverified at runtime.
- `?mock=1` (`service/mock.ts`) ignores the business type and always loads its mobile demo.
- The automatic first-load seed in `createRealRuntime` (empty database, no `?fresh=1`) still loads the mobile demo. Whether
  it should now default to kiryana is a product decision left to the owner.
- No git checkpoint commits were made: the tree holds the owner's unrelated uncommitted work on `main`
  (decision recorded in the previous session).
