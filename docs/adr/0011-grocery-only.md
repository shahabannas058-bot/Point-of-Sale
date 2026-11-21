# ADR-0011: Grocery (kiryana) only; mobile-shop features removed

**Date**: 2026-11-21
**Status**: accepted
**Deciders**: Owner, Claude

## Context

Between 2026-10-11 and 2026-10-18 the POS was built for three business types on one codebase (ADR-0003). The mobile-shop
part went deep: phone units tracked by IMEI, PTA status and condition, repair job tickets, warranties, and a plan for
trade-in, easyload and agent registers and installments. Kiryana was the first type to ship. The owner now sells the
POS only to kiryana and grocery stores. Keeping mobile code means extra tables, screens, invoice fields and tests that
no customer uses, and every grocery change has to be checked against them.

Stored data is the hard part. Invoices are hash-chained and immutable (ADR-0008), so existing hashes must stay valid.
Shops may already hold phone rows in their database, and no row may be lost silently.

## Decision

The POS is grocery only. Business types are `['kiryana']`; the modules are `weight_units` and `batch_expiry`. All phone,
repair, warranty and mobile-only code, tables, screens and demo data are removed. Migration 0009:

- refuses to run (and rolls back) if `phone_units`, `repair_*`, `warranty` or any phone line / movement / product has
  rows, so no data is dropped silently;
- drops the repair and warranty tables and the phone views and triggers;
- renames `accessory_variants` to `items` and every `variant_id` to `item_id`, copying every stored value unchanged.

The invoice hash payload keeps its legacy literal keys forever: `"variantId"` (the item id) and `"phoneUnitId": null`.
Stored hashes therefore stay valid and no hash version is added. The `products.kind` column keeps its CHECK, and every
row keeps the legacy value `'accessory'`.

## Alternatives Considered

### Alternative 1: Hide the mobile code behind a module flag
- **Pros**: nothing is deleted; a mobile shop could be sold later
- **Cons**: dead tables, screens and tests stay in every build; the owner has decided against mobile shops
- **Why not**: the owner decided the product is grocery only, and the cost of keeping hidden code is paid on every change

### Alternative 2: Rename only in code, keep the old tables
- **Pros**: no data migration
- **Cons**: the schema still holds phone and repair tables, and `sale_lines` keeps a `phone_unit_id` column that is always null
- **Why not**: the schema should describe the product that is sold

### Alternative 3: Bump the invoice hash to a new version without the phone keys
- **Pros**: a clean payload
- **Cons**: every stored invoice would need a second hash or a re-hash, and the hash chain would be rewritten
- **Why not**: keeping the legacy keys costs one literal line in the hash code; a re-hash would break the immutability promise

## Consequences

### Positive
- One business type, two modules and a smaller schema, UI and test suite
- Stored invoice hashes and totals do not change; the migration copies every value unchanged
- A database with phone data cannot be upgraded by accident: migration 0009 refuses and the desktop shows a message, with the reset and restore actions

### Negative
- **Irreversible.** Migration 0009 has no down step. Once a shop runs it, the repair, warranty and phone tables are gone. Any database that holds such data must be exported or restored from backup first
- The invoice hash payload carries two keys that no longer mean anything. Any code that builds an invoice hash must keep writing `"variantId"` and `"phoneUnitId": null`, and must never rename or drop them
- Outbox entity type `accessory_variant` is now `item` for new rows only; old frozen outbox rows keep the old name
- `products.kind` keeps the legacy value `'accessory'` in every row
- The C# shell (`apps/shell-dotnet`) was edited for the new names but not compiled here. The owner must run `dotnet build` and `dotnet test` on Windows before the shell ships
- Migrations 0001–0008 are checksum-locked, so the new schema lives only in 0009; the C# migration tests list versions by hand and expect 1 to 9

### Risks
- A shop that ignores the refusal message keeps an old database that cannot open. Mitigation: the desktop boot screen explains the cause and offers reset or restore; the owner must back up before updating
- Rolled-back migration attempts leave no partial state (the runner wraps the whole file), but the owner should verify on a copy of a real shop database before rolling out
- Held bills saved in browser storage carry the old shape. A zustand `persist` version bump with a `migrate` step maps them to items and drops phone lines
