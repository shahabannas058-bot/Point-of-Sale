# TDD evidence: batches and expiry (module batch_expiry)

Date: 2026-10-18. Runner: vitest through npm (`npx vitest run …`, `npm run check`). Design: ADR-0009.

## Source plan

No `*.plan.md`. The journeys come from the owner's request ("batch expiry wala feature bhi banaho") and the previous
session's "Not tried yet" list.

## User journeys

1. As a shopkeeper receiving milk, I enter the batch number and expiry date on the delivery line, so that the app knows
   what expires when.
2. As a cashier, I sell milk and the packet that expires first leaves first, so that nothing is thrown away unsold.
3. As a cashier, I can never sell an expired packet by accident, even if it sits at the front of the shelf record.
4. As a shopkeeper, I open Expiry, see what expires this week and what already expired, and write the expired stock off.
5. As a cashier, a returned packet goes back to the batch it came from.

## Task report

| Task | Validation command | RED | GREEN |
| ---- | ------------------ | --- | ----- |
| Date helpers `pktDate`, `isValidYmd`, `daysBetween` (Pakistan calendar dates) | `npx vitest run packages/shared/test/dates.test.ts` | suite failed to load: `Cannot find module '../src/dates'` | 7 tests pass |
| Migration 0007 + batch ledger + receive / sale / return / write-off / list + module guard | `npx vitest run packages/db/test/service/batches.test.ts packages/db/test/migrations.test.ts` | 17/17 batch tests failed (`Cannot read properties of undefined (reading 'list')`, `no such column: batch_id`), 2 migration tests failed (`expected [1..6] to equal [1..7]`) | all pass |
| Kiryana demo data with dairy batches | `npx vitest run packages/db/test/service/seed-kiryana.test.ts` | `expected 0 to be greater than or equal to 4` | 10 tests pass |
| Same flow on the browser engine (sql.js) | `npx vitest run apps/desktop/test/kiryana-sqljs.test.ts` | not run before the code (written after, see gaps) | 3 tests pass |
| Receive dialog fields, Expiry screen, menu, route, error text | `npm run check` (typecheck + eslint only) | n/a | pass |

Full gate: `npm run check` → exit 0, `Test Files 38 passed (38) | Tests 719 passed (719)`.
(Before this feature: 36 files, 693 tests.)

## Test specification (`packages/db/test/service/batches.test.ts`)

| # | What is guaranteed | Type | Result |
| - | ------------------ | ---- | ------ |
| 1 | A received batch shows its number, expiry date, stock and days left | integration | PASS |
| 2 | The batch number is optional | integration | PASS |
| 3 | Impossible / malformed / missing expiry dates are `VALIDATION` and nothing is written | integration | PASS |
| 4 | A 10 kg loose batch is held in grams and sold by weight (8,750 g left after 1,250 g) | integration | PASS |
| 5 | The outbox gets a `stock_batch` row and a movement carrying the batch id | integration | PASS |
| 6 | A sale takes the nearest-expiry batch first, even when it was received last (-4 then -2) | integration | PASS |
| 7 | Two cart lines of one item consume the batches one after the other | integration | PASS |
| 8 | An expired batch is skipped; short stock fails `STOCK_INSUFFICIENT` with `expiredOnHand` | integration | PASS |
| 9 | Batches are sold before stock without a batch | integration | PASS |
| 10 | With negative stock allowed, the shortfall goes to the no-batch bucket | integration | PASS |
| 11 | A return restores the batches the goods left, in order | integration | PASS |
| 12 | A second partial return does not overfill a batch | integration | PASS |
| 13 | The expiry list is ordered, hides empty batches, and `withinDays` / `variantId` filter it | integration | PASS |
| 14 | `writeOff` removes the batch's stock as an adjustment with the reason; the ledger stays intact | integration | PASS |
| 15 | `writeOff` needs a reason, a real batch with stock, and `adjust_stock` (cashier is `FORBIDDEN`) | integration | PASS |
| 16 | A mobile shop gets `MODULE_DISABLED` for batches and writes nothing | integration | PASS |
| 17 | A plain receive in a kiryana shop still works and sells as before | integration | PASS |

Also: `migrations.test.ts` (versions 1–7, new table and three triggers exist, fake migrations moved to version 8),
`weighted-units.test.ts` (an upgrade from 0005 now passes through 0006 and 0007 with every hash and the chain intact),
`seed-kiryana.test.ts` (expired / this-week / fresh batches exist), `kiryana-sqljs.test.ts` (FEFO, expired skip, return
and the `expiredOnHand` error on sql.js).

## Coverage and known gaps

`--coverage` on the new files: `batches.ts` 99.5 % statements / 92 % branches (only line 106 is not executed),
`dates.ts` 100 %.

- **No browser run.** The Receive dialog fields, the Expiry screen, the menu entry and the `err.STOCK_EXPIRED` message are
  checked by typecheck and lint only; the desktop tests run in `environment: 'node'` and there are no component tests. The
  Chrome extension was not connected in these sessions.
- The sql.js test was written after the code, not before. It exercises the same service through the browser engine, but
  it is not a RED-first test.
- **C# shell.** `MigrationTests.cs` listed tables and versions by hand and had been stale since 0006; it was brought up to
  version 7 and `stock_batches`. Two C# problems that existed before this work were left alone:
  `WebBridgeTests.The_sql_driver_methods_round_trip_values_for_the_typescript_services` fails with or without 0007, and
  `PosShell.Core.Tests` does not compile (`GoldenVectorTests.cs(92,70)`, error CS0411).
- The C# `SalesService` still writes one movement per line and does not know about batches (it never sets `batch_id`);
  a C# port of first-expiry-first-out is future work.
- Receipts do not print the batch; invoices are untouched by design (ADR-0009).
- No git checkpoint commits: the tree holds unrelated uncommitted work on `main`.
