# ADR-0009: Batches and expiry dates on the stock ledger

**Date**: 2026-10-18
**Status**: accepted
**Deciders**: Owner, Claude

## Context

Kiryana stores sell dairy and packed food that expires. The owner needs to know what expires soon, must never sell
expired goods by accident, and wants the older stock to be sold first. Stock is a ledger (`stock_movements`, append-only,
quantity on hand = SUM), invoices are hash-chained and immutable, and quantities are whole numbers in the item's base
unit (ADR-0008). Whatever we add must not rewrite any of that.

## Decision

Module `batch_expiry` (already in the kiryana preset). Migration 0007 adds:

- `stock_batches` (id, variant, branch, optional batch number, `expiry_date` as a Pakistan calendar date `YYYY-MM-DD`,
  purchase, creator, time). Append-only, like the ledger.
- a nullable `stock_movements.batch_id`. A batch's stock is `SUM(quantity) WHERE batch_id = batch`. Every existing row has
  `NULL` and keeps meaning "stock without a batch". A trigger makes a movement point only at a batch of the same item.

Behaviour, all inside `PosService` and gated by the module:

- **Receive**: a purchase line may carry `batch: { batchNo?, expiryDate }`; it creates a batch and the +qty movement
  belongs to it. A shop without the module gets `MODULE_DISABLED`.
- **Sale = first expiry, first out**: the sale's movement is split across batches that have not expired, nearest expiry
  first; whatever they cannot cover comes from stock without a batch. Batches are tried before unlabelled stock because
  their expiry is known.
- **Expired batches are never sold.** They are skipped. If the rest is not enough the sale fails with
  `STOCK_INSUFFICIENT` carrying `expiredOnHand`, and the cart preview shows only the sellable quantity.
- **Return / void**: goods go back into the batches they left from, in the order they left, never more than each batch
  gave (earlier returns of the same sale are counted).
- **Write-off**: `batches.writeOff` moves a batch's whole stock out as an `adjustment` with a reason (permission
  `adjust_stock`). Nothing is deleted.
- **Expiry list**: `batches.list({ withinDays?, variantId? })`, earliest expiry first, stock-holding batches only.
- A date is a day, not a moment, and the shop's day ends at Pakistan midnight (UTC+5, no daylight saving) whatever the
  PC's time zone is.

Invoices, `sale_lines`, the hash and the chain are untouched: batches live only in the stock ledger.

## Alternatives Considered

### Alternative 1: One expiry date per product
- **Pros**: trivial
- **Cons**: a shop holds several deliveries of the same milk with different dates
- **Why not**: cannot answer "which packet expires first"

### Alternative 2: Put the batch on the invoice line
- **Pros**: the receipt could show it
- **Cons**: changes the hashed line, so it needs a new hash version and a `sale_lines` rebuild; a line can span batches
- **Why not**: the customer does not need it, the stock ledger does

### Alternative 3: Block selling an expired batch with an error, instead of skipping it
- **Pros**: very visible
- **Cons**: one forgotten expired packet would stop the counter from selling fresh stock of the same item
- **Why not**: billing speed matters most; the expiry list and the write-off are where expired stock is dealt with

## Consequences

### Positive
- Additive migration: no existing row, hash or total changes; shops without batches behave exactly as before
  (one movement per sale line)
- Conflict-free sync is kept: batches and batch-carrying movements are new outbox entities (`stock_batch`)

### Negative
- A sale line can produce several movements, so "one movement per line" is no longer true for batch-tracked items
- An item's `onHand` still counts expired stock; the sellable quantity is `onHand - expiredOnHand`
- The C# shell embeds the same migrations and its tests list tables and versions by hand; they must be kept in step

### Risks
- A cashier who ignores the expiry list sees "not enough fresh stock" with stock still on the shelf; the message names
  the expired quantity so it can be written off. The reverse (selling expired goods) cannot happen through `PosService`
- With `allowNegativeStock` on, a shortfall is booked to the no-batch bucket, which can go negative
