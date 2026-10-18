-- 0007_batch_expiry.sql : batches and expiry dates for perishable goods (kiryana, module batch_expiry).
-- Stock stays a ledger: a movement may point at the batch it belongs to. A batch's on-hand is
-- SUM(stock_movements.quantity) WHERE batch_id = batch. Movements without a batch (all existing rows) are untouched.

CREATE TABLE stock_batches (
  id          TEXT PRIMARY KEY CHECK (length(id) = 36),
  variant_id  TEXT NOT NULL REFERENCES accessory_variants (id),
  branch_id   TEXT NOT NULL REFERENCES branches (id),
  batch_no    TEXT CHECK (batch_no IS NULL OR length(batch_no) BETWEEN 1 AND 60),
  -- Pakistan calendar date, YYYY-MM-DD (text sorts in date order)
  expiry_date TEXT NOT NULL CHECK (expiry_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  purchase_id TEXT REFERENCES purchases (id),
  created_by  TEXT NOT NULL REFERENCES users (id),
  created_at  INTEGER NOT NULL
) STRICT;
CREATE INDEX ix_batches_variant ON stock_batches (variant_id, expiry_date);
CREATE INDEX ix_batches_expiry  ON stock_batches (expiry_date);

CREATE TRIGGER trg_stock_batches_no_update BEFORE UPDATE ON stock_batches
BEGIN SELECT RAISE(ABORT, 'stock_batches is append-only: write the stock off with an adjustment instead'); END;
CREATE TRIGGER trg_stock_batches_no_delete BEFORE DELETE ON stock_batches
BEGIN SELECT RAISE(ABORT, 'stock_batches is append-only: write the stock off with an adjustment instead'); END;

ALTER TABLE stock_movements ADD COLUMN batch_id TEXT REFERENCES stock_batches (id);
CREATE INDEX ix_sm_batch ON stock_movements (batch_id) WHERE batch_id IS NOT NULL;

-- A movement can only point at a batch of the same item (and never at one from a phone movement).
CREATE TRIGGER trg_stock_movements_batch_guard BEFORE INSERT ON stock_movements
WHEN NEW.batch_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'stock_movements: batch belongs to a different item')
  WHERE NOT EXISTS (
    SELECT 1 FROM stock_batches WHERE id = NEW.batch_id AND variant_id IS NEW.variant_id
  );
END;
