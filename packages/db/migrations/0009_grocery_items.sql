-- 0009_grocery_items.sql : the app is grocery (kiryana) only. Removes the mobile-shop schema (phone units, repair
-- tickets, warranties) and renames accessory variants to plain "items":
--   accessory_variants          -> items
--   *.variant_id                -> *.item_id (stock_movements, sale_lines, stock_batches)
--   stock_movements / sale_lines lose phone_unit_id, and item_id becomes NOT NULL
-- Every stored value is copied unchanged, so invoice hashes stay valid. The hash payload keeps its legacy keys
-- ("variantId", "phoneUnitId": null) in code, not in the schema.
-- products.kind keeps its CHECK; every row stores the legacy value 'accessory' (the column cannot be rebuilt
-- without rebuilding every table that references products).
-- foreign_keys stays ON (the runner forbids PRAGMA), so dependants are dropped before their table and every
-- rebuilt table is copied before the old one is dropped. ALTER ... RENAME rewrites foreign keys in other tables.

-- 1. Refuse to run while any mobile-shop data exists: nothing may be lost silently. A non-zero count fails the CHECK
--    named after it, and the runner rolls the whole migration back.
CREATE TEMP TABLE _guard_0009 (
  what TEXT NOT NULL,
  n    INTEGER NOT NULL,
  CONSTRAINT "grocery upgrade refused: phone_units has rows (mobile-shop data)"
    CHECK (what <> 'phone_units' OR n = 0),
  CONSTRAINT "grocery upgrade refused: repair_tickets has rows (mobile-shop data)"
    CHECK (what <> 'repair_tickets' OR n = 0),
  CONSTRAINT "grocery upgrade refused: repair_status_history has rows (mobile-shop data)"
    CHECK (what <> 'repair_status_history' OR n = 0),
  CONSTRAINT "grocery upgrade refused: repair_parts has rows (mobile-shop data)"
    CHECK (what <> 'repair_parts' OR n = 0),
  CONSTRAINT "grocery upgrade refused: repair_payments has rows (mobile-shop data)"
    CHECK (what <> 'repair_payments' OR n = 0),
  CONSTRAINT "grocery upgrade refused: warranties has rows (mobile-shop data)"
    CHECK (what <> 'warranties' OR n = 0),
  CONSTRAINT "grocery upgrade refused: sale_lines has phone lines (mobile-shop data)"
    CHECK (what <> 'sale_lines.phone_unit_id' OR n = 0),
  CONSTRAINT "grocery upgrade refused: stock_movements has phone movements (mobile-shop data)"
    CHECK (what <> 'stock_movements.phone_unit_id' OR n = 0),
  CONSTRAINT "grocery upgrade refused: products has phone products (mobile-shop data)"
    CHECK (what <> 'products.kind_phone' OR n = 0)
);
INSERT INTO _guard_0009 SELECT 'phone_units', COUNT(*) FROM phone_units;
INSERT INTO _guard_0009 SELECT 'repair_tickets', COUNT(*) FROM repair_tickets;
INSERT INTO _guard_0009 SELECT 'repair_status_history', COUNT(*) FROM repair_status_history;
INSERT INTO _guard_0009 SELECT 'repair_parts', COUNT(*) FROM repair_parts;
INSERT INTO _guard_0009 SELECT 'repair_payments', COUNT(*) FROM repair_payments;
INSERT INTO _guard_0009 SELECT 'warranties', COUNT(*) FROM warranties;
INSERT INTO _guard_0009 SELECT 'sale_lines.phone_unit_id', COUNT(*) FROM sale_lines WHERE phone_unit_id IS NOT NULL;
INSERT INTO _guard_0009 SELECT 'stock_movements.phone_unit_id', COUNT(*) FROM stock_movements WHERE phone_unit_id IS NOT NULL;
INSERT INTO _guard_0009 SELECT 'products.kind_phone', COUNT(*) FROM products WHERE kind = 'phone';
DROP TABLE _guard_0009;

-- 2. Warranty and repair tables, children first (their triggers and indexes go with them).
DROP TABLE warranties;
DROP TABLE repair_parts;
DROP TABLE repair_payments;
DROP TABLE repair_status_history;
DROP TABLE repair_tickets;

-- 3. Views and triggers that name the tables or columns rebuilt below. The ones still needed come back at the end.
DROP VIEW v_phone_unit_on_hand;
DROP VIEW v_variant_on_hand;
DROP VIEW v_sale_line_mismatch;
DROP TRIGGER trg_stock_movements_unit_guard;
DROP TRIGGER trg_stock_movements_batch_guard;
DROP TRIGGER trg_sale_lines_unit_scale;
DROP TRIGGER trg_variants_unit_insert;
DROP TRIGGER trg_variants_unit_update;

-- 4. accessory_variants -> items (foreign keys in stock_batches, stock_movements and sale_lines follow the rename).
ALTER TABLE accessory_variants RENAME TO items;
DROP INDEX ux_variants_barcode;
DROP INDEX ix_variants_product;
CREATE UNIQUE INDEX ux_items_barcode ON items (barcode) WHERE barcode IS NOT NULL;
CREATE INDEX ix_items_product ON items (product_id);

-- 5. stock_batches.variant_id -> item_id
ALTER TABLE stock_batches RENAME COLUMN variant_id TO item_id;
DROP INDEX ix_batches_variant;
CREATE INDEX ix_batches_item ON stock_batches (item_id, expiry_date);

-- 6. stock_movements without phone_unit_id; item_id is required.
CREATE TABLE stock_movements_v2 (
  id         TEXT PRIMARY KEY CHECK (length(id) = 36),
  branch_id  TEXT NOT NULL REFERENCES branches (id),
  type       TEXT NOT NULL CHECK (type IN ('sale', 'purchase', 'return', 'adjustment', 'transfer')),
  item_id    TEXT NOT NULL REFERENCES items (id),
  quantity   INTEGER NOT NULL CHECK (quantity <> 0), -- base units
  unit_cost  INTEGER CHECK (unit_cost IS NULL OR unit_cost >= 0),
  ref_type   TEXT CHECK (ref_type IS NULL OR ref_type IN ('sale', 'purchase', 'transfer')),
  ref_id     TEXT,
  reason     TEXT,
  created_by TEXT NOT NULL REFERENCES users (id),
  created_at INTEGER NOT NULL,
  batch_id   TEXT REFERENCES stock_batches (id),
  CHECK ((ref_type IS NULL) = (ref_id IS NULL)),
  CHECK (type <> 'sale' OR quantity < 0),
  CHECK (type <> 'purchase' OR quantity > 0),
  CHECK (type <> 'adjustment' OR (reason IS NOT NULL AND length(reason) > 0)),
  CHECK (type <> 'transfer' OR ref_type IS 'transfer')
) STRICT;

INSERT INTO stock_movements_v2 (id, branch_id, type, item_id, quantity, unit_cost, ref_type, ref_id, reason,
                                created_by, created_at, batch_id)
SELECT id, branch_id, type, variant_id, quantity, unit_cost, ref_type, ref_id, reason,
       created_by, created_at, batch_id
FROM stock_movements;

DROP TABLE stock_movements;
ALTER TABLE stock_movements_v2 RENAME TO stock_movements;

CREATE INDEX ix_sm_item    ON stock_movements (item_id, branch_id);
CREATE INDEX ix_sm_ref     ON stock_movements (ref_type, ref_id);
CREATE INDEX ix_sm_created ON stock_movements (created_at);
CREATE INDEX ix_sm_batch   ON stock_movements (batch_id) WHERE batch_id IS NOT NULL;

CREATE TRIGGER trg_stock_movements_no_update BEFORE UPDATE ON stock_movements
BEGIN SELECT RAISE(ABORT, 'stock_movements is append-only: add a compensating movement instead'); END;
CREATE TRIGGER trg_stock_movements_no_delete BEFORE DELETE ON stock_movements
BEGIN SELECT RAISE(ABORT, 'stock_movements is append-only: add a compensating movement instead'); END;

-- A movement can only point at a batch of the same item.
CREATE TRIGGER trg_stock_movements_batch_guard BEFORE INSERT ON stock_movements
WHEN NEW.batch_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'stock_movements: batch belongs to a different item')
  WHERE NOT EXISTS (
    SELECT 1 FROM stock_batches WHERE id = NEW.batch_id AND item_id = NEW.item_id
  );
END;

-- 7. sale_lines without phone_unit_id; item_id is required. Same line_total rule as 0006.
CREATE TABLE sale_lines_v2 (
  id              TEXT PRIMARY KEY CHECK (length(id) = 36),
  sale_id         TEXT NOT NULL REFERENCES sales (id),
  line_no         INTEGER NOT NULL CHECK (line_no >= 1),
  product_id      TEXT NOT NULL REFERENCES products (id),
  item_id         TEXT NOT NULL REFERENCES items (id),
  description     TEXT NOT NULL,
  quantity        INTEGER NOT NULL CHECK (quantity <> 0), -- base units
  unit_price      INTEGER NOT NULL CHECK (unit_price >= 0), -- per priced unit (per piece / per kg)
  cost_price      INTEGER NOT NULL CHECK (cost_price >= 0), -- snapshot per priced unit, for profit reports
  discount_amount INTEGER NOT NULL DEFAULT 0,
  line_total      INTEGER NOT NULL,
  unit_scale      INTEGER NOT NULL DEFAULT 1 CHECK (unit_scale IN (1, 1000)),
  created_at      INTEGER NOT NULL,
  UNIQUE (sale_id, line_no),
  CHECK (line_total = (CASE WHEN quantity * unit_price >= 0
                         THEN (quantity * unit_price + unit_scale / 2) / unit_scale
                         ELSE -((-(quantity * unit_price) + unit_scale / 2) / unit_scale) END) - discount_amount)
) STRICT;

INSERT INTO sale_lines_v2 (id, sale_id, line_no, product_id, item_id, description, quantity,
                           unit_price, cost_price, discount_amount, line_total, unit_scale, created_at)
SELECT id, sale_id, line_no, product_id, variant_id, description, quantity,
       unit_price, cost_price, discount_amount, line_total, unit_scale, created_at
FROM sale_lines;

DROP TABLE sale_lines;
ALTER TABLE sale_lines_v2 RENAME TO sale_lines;

CREATE INDEX ix_sale_lines_item ON sale_lines (item_id);

CREATE TRIGGER trg_sale_lines_no_update BEFORE UPDATE ON sale_lines
BEGIN SELECT RAISE(ABORT, 'sale_lines is immutable'); END;
CREATE TRIGGER trg_sale_lines_no_delete BEFORE DELETE ON sale_lines
BEGIN SELECT RAISE(ABORT, 'sale_lines is immutable'); END;

-- a line must carry the scale its item has, so a sale can never be priced in the wrong unit
CREATE TRIGGER trg_sale_lines_unit_scale BEFORE INSERT ON sale_lines
BEGIN
  SELECT RAISE(ABORT, 'sale_lines: unit_scale must match the item')
  WHERE NEW.unit_scale <> (SELECT unit_scale FROM items WHERE id = NEW.item_id);
END;

-- 8. Phone units go last: nothing references them any more.
DROP TABLE phone_units;

-- Item unit rules (were trg_variants_unit_*; created after the stock_movements rebuild because they read it).
CREATE TRIGGER trg_items_unit_insert BEFORE INSERT ON items
BEGIN
  SELECT RAISE(ABORT, 'items: unit_scale must match unit_label')
  WHERE NOT ((NEW.unit_label = 'pcs' AND NEW.unit_scale = 1) OR (NEW.unit_label IN ('kg', 'L') AND NEW.unit_scale = 1000));
END;

CREATE TRIGGER trg_items_unit_update BEFORE UPDATE OF unit_scale, unit_label ON items
BEGIN
  SELECT RAISE(ABORT, 'items: unit_scale must match unit_label')
  WHERE NOT ((NEW.unit_label = 'pcs' AND NEW.unit_scale = 1) OR (NEW.unit_label IN ('kg', 'L') AND NEW.unit_scale = 1000));
  SELECT RAISE(ABORT, 'items: unit cannot change once stock exists')
  WHERE (NEW.unit_scale <> OLD.unit_scale OR NEW.unit_label <> OLD.unit_label)
    AND EXISTS (SELECT 1 FROM stock_movements WHERE item_id = OLD.id);
END;

-- Derived views (no stored counts) and integrity checks (rows returned = problems)
CREATE VIEW v_item_on_hand AS
SELECT item_id, branch_id, SUM(quantity) AS on_hand
FROM stock_movements
GROUP BY item_id, branch_id;

CREATE VIEW v_sale_line_mismatch AS
SELECT s.id AS sale_id, s.subtotal AS subtotal, COALESCE(SUM(l.line_total), 0) AS lines_total
FROM sales s LEFT JOIN sale_lines l ON l.sale_id = s.id
GROUP BY s.id HAVING s.subtotal <> COALESCE(SUM(l.line_total), 0);
