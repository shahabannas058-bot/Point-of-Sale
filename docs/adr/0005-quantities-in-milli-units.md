# ADR-0005: Quantities stored as integer milli-units

**Date**: 2026-10-18
**Status**: superseded by [ADR-0008](0008-per-item-unit-scale.md)
**Deciders**: Owner, Claude

> Superseded the same day. Reading the code showed that multiplying every stored quantity by 1000 would rewrite
> hashed, immutable invoices (and touch about 50 files). ADR-0008 reaches the same goal (exact kg / gram
> arithmetic) with a per-item unit scale and leaves every stored row and hash untouched.

## Context

The stock ledger stores `quantity` as an INTEGER and phone units are constrained to exactly +1/-1. Kiryana stores sell loose items by weight (1.5 kg sugar), which an integer count cannot hold. Floating point is not allowed for stock or money because rounding errors accumulate and break the ledger sums.

## Decision

Quantity is stored as an integer in milli-units: 1000 = 1 piece or 1 kg. Piece-counted items always use multiples of 1000, and phone units stay at exactly +1000 or -1000. Migration 0006 multiplies existing quantities by 1000.

## Alternatives Considered

### Alternative 1: REAL / floating point quantities
- **Pros**: easy to write
- **Cons**: rounding drift, sums no longer exact
- **Why not**: breaks the "stock is a ledger" rule

### Alternative 2: Separate integer table for weighted items
- **Pros**: no change to existing data
- **Cons**: two stock systems, double reporting logic
- **Why not**: more code and more bugs than one scaled integer

## Consequences

### Positive
- Exact arithmetic, same idea as money in paisa

### Negative
- Every place that shows or enters a quantity must scale by 1000
- A data migration touches existing records

### Risks
- Missed scaling would show stock 1000 times too large; mitigated by migration tests and `npm run check`
