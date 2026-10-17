-- Khata ledgers (customers and suppliers) and the sync outbox.

-- Signed amounts. Customer: + they owe us more, - they paid / got credit back.
-- Supplier: + we owe them more, - we paid them.
CREATE TABLE ledger_entries (
  id          TEXT    PRIMARY KEY,
  customer_id TEXT    REFERENCES customers (id),
  supplier_id TEXT    REFERENCES suppliers (id),
  type        TEXT    NOT NULL CHECK (type IN ('sale_credit', 'payment_received', 'return_credit', 'purchase_credit',
                                              'payment_made', 'purchase_return', 'opening_balance', 'adjustment')),
  amount      INTEGER NOT NULL CHECK (amount <> 0),
  method      TEXT    CHECK (method IS NULL OR method IN ('cash', 'jazzcash', 'easypaisa', 'bank_transfer', 'card')),
  sale_id     TEXT    REFERENCES sales (id),
  purchase_id TEXT    REFERENCES purchases (id),
  note        TEXT,
  created_by  TEXT    NOT NULL REFERENCES users (id),
  created_at  INTEGER NOT NULL,
  CHECK ((customer_id IS NULL) <> (supplier_id IS NULL))
) STRICT;

CREATE INDEX ledger_customer ON ledger_entries (customer_id, created_at);
CREATE INDEX ledger_supplier ON ledger_entries (supplier_id, created_at);

CREATE TRIGGER ledger_entries_no_update
BEFORE UPDATE ON ledger_entries
BEGIN
  SELECT RAISE(ABORT, 'ledger_entries is append-only');
END;

CREATE TRIGGER ledger_entries_no_delete
BEFORE DELETE ON ledger_entries
BEGIN
  SELECT RAISE(ABORT, 'ledger_entries is append-only');
END;

-- Every local write appends here; the sync worker (Phase 2) drains it.
CREATE TABLE outbox (
  id          TEXT    PRIMARY KEY,
  entity_type TEXT    NOT NULL,
  entity_id   TEXT    NOT NULL,
  op          TEXT    NOT NULL CHECK (op IN ('insert', 'update')),
  payload     TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  sent_at     INTEGER
) STRICT;

CREATE INDEX outbox_unsent ON outbox (sent_at, created_at);

CREATE TRIGGER outbox_only_delivery_fields
BEFORE UPDATE ON outbox
WHEN NEW.id IS NOT OLD.id OR NEW.entity_type IS NOT OLD.entity_type OR NEW.entity_id IS NOT OLD.entity_id
  OR NEW.op IS NOT OLD.op OR NEW.payload IS NOT OLD.payload OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'outbox: only attempts, last_error and sent_at may change');
END;
