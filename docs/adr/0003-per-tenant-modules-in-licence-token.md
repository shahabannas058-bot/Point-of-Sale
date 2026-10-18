# ADR-0003: One product, per-tenant modules carried in the licence token

**Date**: 2026-10-18
**Status**: accepted
**Deciders**: Owner, Claude

## Context

The owner wants to sell the same POS to kiryana stores, mobile shops and laptop shops without building a separate app for each. A mobile shop must not see kiryana features and the reverse. Kiryana ships first, mobile second, laptop third.

## Decision

There is one codebase and one installer. A tenant has a `business_type` and a `modules[]` list (for example `weight_units`, `batch_expiry`, `imei`, `repair`, `warranty`). The list is placed inside the Ed25519-signed licence token, so the shopkeeper cannot edit it. `PosService` rejects any call to a module the tenant does not own; hiding menu items alone is not enough. An always-on `core` module covers billing, stock ledger, returns, khata, reports and users.

## Alternatives Considered

### Alternative 1: Separate app per business type
- **Pros**: simple to reason about per product
- **Cons**: three codebases, three installers, bug fixes done three times
- **Why not**: the owner explicitly does not want this

### Alternative 2: Hide menus only, no enforcement
- **Pros**: trivial
- **Cons**: a shop could reach other modules through the UI or API
- **Why not**: modules are a paid feature, so they must be enforced

## Consequences

### Positive
- New business types are new module presets, not new products
- The owner can turn a module on or off for a shop from the admin panel

### Negative
- Module boundaries need care so that `core` does not depend on optional modules

### Risks
- A skilled user can patch a local PC; accepted by the threat model (ordinary shopkeeper), see ADR-0004
