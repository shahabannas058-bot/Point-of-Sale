-- 0002_stock.sql : purchases + stock ledger (append-only). Quantity on hand = SUM(quantity); never stored.

CREATE TABLE purchases (
  id           TEXT PRIMARY KEY CHECK (length(id) = 36),
  supplier_id  TEXT NOT NULL REFERENCES suppliers (id),
  branch_id    TEXT NOT NULL REFERENCES branches (id),
  kind         TEXT NOT NULL CHECK (kind IN ('purchase', 'return')),
  reference_no TEXT,
  total        INTEGER NOT NULL,
  note         TEXT,
  created_by   TEXT NOT NULL REFERENCES users (id),
  created_at   INTEGER NOT NULL,
  CHECK ((kind = 'purchase' AND total >= 0) OR (kind = 'return' AND total <= 0))
) STRICT;
CREATE INDEX ix_purchases_supplier ON purchases (supplier_id, created_at);

CREATE TABLE stock_movements (
  id            TEXT PRIMARY KEY CHECK (length(id) = 36),
  branch_id     TEXT NOT NULL REFERENCES branches (id),
  type          TEXT NOT NULL CHECK (type IN ('sale', 'purchase', 'return', 'adjustment', 'transfer')),
  phone_unit_id TEXT REFERENCES phone_units (id),
  variant_id    TEXT REFERENCES accessory_variants (id),
  quantity      INTEGER NOT NULL CHECK (quantity <> 0),
  unit_cost     INTEGER CHECK (unit_cost IS NULL OR unit_cost >= 0),
  ref_type      TEXT CHECK (ref_type IS NULL OR ref_type IN ('sale', 'purchase', 'transfer')),
  ref_id        TEXT,
  reason        TEXT,
  created_by    TEXT NOT NULL REFERENCES users (id),
  created_at    INTEGER NOT NULL,
  CHECK ((phone_unit_id IS NOT NULL) <> (variant_id IS NOT NULL)),
  CHECK (phone_unit_id IS NULL OR quantity IN (-1, 1)),
  CHECK ((ref_type IS NULL) = (ref_id IS NULL)),
  CHECK (type <> 'sale' OR quantity < 0),
  CHECK (type <> 'purchase' OR quantity > 0),
  CHECK (type <> 'adjustment' OR (reason IS NOT NULL AND length(reason) > 0)),
  CHECK (type <> 'transfer' OR ref_type IS 'transfer')
) STRICT;
CREATE INDEX ix_sm_variant ON stock_movements (variant_id, branch_id) WHERE variant_id IS NOT NULL;
CREATE INDEX ix_sm_unit    ON stock_movements (phone_unit_id)         WHERE phone_unit_id IS NOT NULL;
CREATE INDEX ix_sm_ref     ON stock_movements (ref_type, ref_id);
CREATE INDEX ix_sm_created ON stock_movements (created_at);

-- A phone unit's global on-hand must stay within 0..1.
-- For a transfer, insert the -1 row (source branch) BEFORE the +1 row (destination branch).
CREATE TRIGGER trg_stock_movements_unit_guard BEFORE INSERT ON stock_movements
WHEN NEW.phone_unit_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'stock_movements: phone unit on-hand must stay within 0..1')
  WHERE (SELECT COALESCE(SUM(quantity), 0) FROM stock_movements WHERE phone_unit_id = NEW.phone_unit_id)
        + NEW.quantity NOT BETWEEN 0 AND 1;
END;

CREATE TRIGGER trg_stock_movements_no_update BEFORE UPDATE ON stock_movements
BEGIN SELECT RAISE(ABORT, 'stock_movements is append-only: add a compensating movement instead'); END;
CREATE TRIGGER trg_stock_movements_no_delete BEFORE DELETE ON stock_movements
BEGIN SELECT RAISE(ABORT, 'stock_movements is append-only: add a compensating movement instead'); END;

CREATE TRIGGER trg_purchases_no_update BEFORE UPDATE ON purchases
BEGIN SELECT RAISE(ABORT, 'purchases is append-only: record a purchase return instead'); END;
CREATE TRIGGER trg_purchases_no_delete BEFORE DELETE ON purchases
BEGIN SELECT RAISE(ABORT, 'purchases is append-only: record a purchase return instead'); END;

-- Derived views (no stored counts)
CREATE VIEW v_variant_on_hand AS
SELECT variant_id, branch_id, SUM(quantity) AS on_hand
FROM stock_movements WHERE variant_id IS NOT NULL
GROUP BY variant_id, branch_id;

CREATE VIEW v_phone_unit_on_hand AS
SELECT phone_unit_id, branch_id, SUM(quantity) AS on_hand
FROM stock_movements WHERE phone_unit_id IS NOT NULL
GROUP BY phone_unit_id, branch_id HAVING SUM(quantity) <> 0;
