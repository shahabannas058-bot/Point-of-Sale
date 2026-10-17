-- Stock is a ledger, not a number: on-hand = SUM(quantity) of stock_movements. Rows are never changed.

CREATE TABLE purchases (
  id           TEXT    PRIMARY KEY,
  supplier_id  TEXT    NOT NULL REFERENCES suppliers (id),
  branch_id    TEXT    NOT NULL REFERENCES branches (id),
  kind         TEXT    NOT NULL DEFAULT 'purchase' CHECK (kind IN ('purchase', 'return')),
  reference_no TEXT,
  total        INTEGER NOT NULL,
  note         TEXT,
  created_by   TEXT    NOT NULL REFERENCES users (id),
  created_at   INTEGER NOT NULL
) STRICT;

CREATE INDEX purchases_supplier ON purchases (supplier_id, created_at);

CREATE TABLE stock_movements (
  id            TEXT    PRIMARY KEY,
  branch_id     TEXT    NOT NULL REFERENCES branches (id),
  type          TEXT    NOT NULL CHECK (type IN ('opening', 'purchase', 'sale', 'return', 'void', 'adjustment', 'purchase_return')),
  phone_unit_id TEXT    REFERENCES phone_units (id),
  variant_id    TEXT    REFERENCES accessory_variants (id),
  quantity      INTEGER NOT NULL CHECK (quantity <> 0),
  unit_cost     INTEGER,
  ref_type      TEXT,
  ref_id        TEXT,
  reason        TEXT,
  created_by    TEXT    NOT NULL REFERENCES users (id),
  created_at    INTEGER NOT NULL,
  CHECK ((phone_unit_id IS NULL) <> (variant_id IS NULL))
) STRICT;

CREATE INDEX stock_movements_variant ON stock_movements (variant_id, branch_id);
CREATE INDEX stock_movements_unit ON stock_movements (phone_unit_id, branch_id);
CREATE INDEX stock_movements_ref ON stock_movements (ref_type, ref_id);

CREATE TRIGGER stock_movements_no_update
BEFORE UPDATE ON stock_movements
BEGIN
  SELECT RAISE(ABORT, 'stock_movements is append-only');
END;

CREATE TRIGGER stock_movements_no_delete
BEFORE DELETE ON stock_movements
BEGIN
  SELECT RAISE(ABORT, 'stock_movements is append-only');
END;

-- A phone is either in stock (1) or not (0). Selling it twice or receiving it twice is impossible.
CREATE TRIGGER stock_movements_phone_unit_range
AFTER INSERT ON stock_movements
WHEN NEW.phone_unit_id IS NOT NULL
  AND (SELECT SUM(quantity) FROM stock_movements WHERE phone_unit_id = NEW.phone_unit_id) NOT BETWEEN 0 AND 1
BEGIN
  SELECT RAISE(ABORT, 'phone unit on-hand must stay within 0..1');
END;

CREATE VIEW v_variant_on_hand AS
SELECT av.id AS variant_id,
       b.id  AS branch_id,
       COALESCE((SELECT SUM(sm.quantity) FROM stock_movements sm
                 WHERE sm.variant_id = av.id AND sm.branch_id = b.id), 0) AS on_hand
FROM accessory_variants av CROSS JOIN branches b;

CREATE VIEW v_phone_unit_on_hand AS
SELECT pu.id AS phone_unit_id,
       COALESCE((SELECT SUM(sm.quantity) FROM stock_movements sm WHERE sm.phone_unit_id = pu.id), 0) AS on_hand
FROM phone_units pu;
