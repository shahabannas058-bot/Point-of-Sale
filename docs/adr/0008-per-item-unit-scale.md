# ADR-0008: Per-item unit scale for loose goods (kg / litre)

**Date**: 2026-10-18
**Status**: accepted (supersedes ADR-0005)
**Deciders**: Owner, Claude

## Context

Kiryana stores sell loose goods by weight (1.25 kg of sugar at Rs 285.50 per kg). Stock and sale quantities were whole
pieces. ADR-0005 proposed multiplying every stored quantity by 1000. Reading the code showed the cost: `quantity` is part
of each invoice hash, `sale_lines` has a CHECK `line_total = quantity * unit_price - discount`, and about 50 files and 439
places use quantities. Rewriting stored quantities would rewrite hashed, immutable invoices and break the hash chain.

## Decision

Quantities stay whole numbers in the item's base unit: pieces, or grams / millilitres. Each accessory variant gets
`unit_scale` (1 = piece, 1000 = kg or litre) and `unit_label` (`pcs`, `kg`, `L`). Prices are per priced unit (per piece,
per kg). `line_total = round_half_away_from_zero(quantity * unit_price / unit_scale) - discount`, implemented identically
in `lineGross()` (TypeScript), the `sale_lines` CHECK, the reports SQL and the C# port. `sale_lines` stores a `unit_scale`
snapshot; invoice `hash_version` 2 hashes it, while version 1 invoices keep their exact original hash. A variant's unit
cannot change once it has stock movements, and a sale line must carry its variant's scale (both enforced by triggers).
Phone units are always pieces.

## Alternatives Considered

### Alternative 1: Global milli-units (ADR-0005)
- **Pros**: one uniform representation
- **Cons**: rewrites immutable invoices and their hashes, large migration, touches every quantity in the app
- **Why not**: breaks the "sales are immutable and hash-chained" rule for no extra capability

### Alternative 2: Fractional paisa per gram
- **Pros**: no change to the line formula
- **Cons**: Rs 275.50/kg is 27.55 paisa/g, not an integer
- **Why not**: cannot represent real kiryana prices exactly

### Alternative 3: REAL / floating point quantities
- **Pros**: easy to write
- **Cons**: rounding drift; ledger sums stop being exact
- **Why not**: breaks the "stock is a ledger" rule

## Consequences

### Positive
- Every stored row, quantity, line total and invoice hash stays valid; the upgrade is additive
- Piece items, phones and all existing tests behave exactly as before (scale 1 gives the old formula)
- Exact integer arithmetic for kg and litres, with one documented rounding rule

### Negative
- The rounding rule must be implemented the same way in four places (TS, SQL CHECK, reports SQL, C#); golden vectors
  `v2-*` in `testdata/invoice-vectors.json` pin it
- A weighed line returned in several parts is rounded per return, so the refunds can differ from the original line total
  by at most one paisa per extra return (a single full return, and a void, are exact)
- Prices and costs of loose items are "per kg" while stock is in grams: screens must convert (`lib/qty.ts`)

### Risks
- A new screen that forgets the scale would show a quantity 1000 times too large or small; mitigated by routing quantity
  display and entry through `qtyText`, `variantQtyText`, `parseQuantity` and `lineGross`, all unit tested
