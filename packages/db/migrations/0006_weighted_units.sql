-- 0006_weighted_units.sql : loose goods sold by kg / litre (kiryana). See ADR-0008.
-- Quantities stay whole numbers in the item's BASE unit (pieces, or grams / millilitres). `unit_scale` says how many
-- base units make one PRICED unit (1 = piece, 1000 = kg / litre); prices are per priced unit.
-- line_total = round_half_away_from_zero(quantity * unit_price / unit_scale) - discount_amount.
-- Every existing row has scale 1, so stored quantities, line totals and invoice hashes stay valid.

ALTER TABLE accessory_variants ADD COLUMN unit_scale INTEGER NOT NULL DEFAULT 1 CHECK (unit_scale IN (1, 1000));
ALTER TABLE accessory_variants ADD COLUMN unit_label TEXT    NOT NULL DEFAULT 'pcs' CHECK (unit_label IN ('pcs', 'kg', 'L'));

CREATE TRIGGER trg_variants_unit_insert BEFORE INSERT ON accessory_variants
BEGIN
  SELECT RAISE(ABORT, 'accessory_variants: unit_scale must match unit_label')
  WHERE NOT ((NEW.unit_label = 'pcs' AND NEW.unit_scale = 1) OR (NEW.unit_label IN ('kg', 'L') AND NEW.unit_scale = 1000));
END;

CREATE TRIGGER trg_variants_unit_update BEFORE UPDATE OF unit_scale, unit_label ON accessory_variants
BEGIN
  SELECT RAISE(ABORT, 'accessory_variants: unit_scale must match unit_label')
  WHERE NOT ((NEW.unit_label = 'pcs' AND NEW.unit_scale = 1) OR (NEW.unit_label IN ('kg', 'L') AND NEW.unit_scale = 1000));
  SELECT RAISE(ABORT, 'accessory_variants: unit cannot change once stock exists')
  WHERE (NEW.unit_scale <> OLD.unit_scale OR NEW.unit_label <> OLD.unit_label)
    AND EXISTS (SELECT 1 FROM stock_movements WHERE variant_id = OLD.id);
END;

-- sale_lines: new column + a new line_total rule, so the table is rebuilt. Objects that reference it are dropped first
-- (SQLite validates them on RENAME) and recreated afterwards, unchanged.
DROP VIEW v_sale_line_mismatch;
DROP TRIGGER warranties_unit_on_sale;

CREATE TABLE sale_lines_v2 (
  id              TEXT PRIMARY KEY CHECK (length(id) = 36),
  sale_id         TEXT NOT NULL REFERENCES sales (id),
  line_no         INTEGER NOT NULL CHECK (line_no >= 1),
  product_id      TEXT NOT NULL REFERENCES products (id),
  phone_unit_id   TEXT REFERENCES phone_units (id),
  variant_id      TEXT REFERENCES accessory_variants (id),
  description     TEXT NOT NULL,
  quantity        INTEGER NOT NULL CHECK (quantity <> 0), -- base units
  unit_price      INTEGER NOT NULL CHECK (unit_price >= 0), -- per priced unit (per piece / per kg)
  cost_price      INTEGER NOT NULL CHECK (cost_price >= 0), -- snapshot per priced unit, for profit reports
  discount_amount INTEGER NOT NULL DEFAULT 0,
  line_total      INTEGER NOT NULL,
  unit_scale      INTEGER NOT NULL DEFAULT 1 CHECK (unit_scale IN (1, 1000)),
  created_at      INTEGER NOT NULL,
  UNIQUE (sale_id, line_no),
  CHECK ((phone_unit_id IS NOT NULL) <> (variant_id IS NOT NULL)),
  CHECK (phone_unit_id IS NULL OR (quantity IN (-1, 1) AND unit_scale = 1)),
  CHECK (line_total = (CASE WHEN quantity * unit_price >= 0
                         THEN (quantity * unit_price + unit_scale / 2) / unit_scale
                         ELSE -((-(quantity * unit_price) + unit_scale / 2) / unit_scale) END) - discount_amount)
) STRICT;

INSERT INTO sale_lines_v2 (id, sale_id, line_no, product_id, phone_unit_id, variant_id, description, quantity,
                           unit_price, cost_price, discount_amount, line_total, unit_scale, created_at)
SELECT id, sale_id, line_no, product_id, phone_unit_id, variant_id, description, quantity,
       unit_price, cost_price, discount_amount, line_total, 1, created_at
FROM sale_lines;

DROP TABLE sale_lines;
ALTER TABLE sale_lines_v2 RENAME TO sale_lines;

CREATE INDEX ix_sale_lines_unit    ON sale_lines (phone_unit_id) WHERE phone_unit_id IS NOT NULL;
CREATE INDEX ix_sale_lines_variant ON sale_lines (variant_id)    WHERE variant_id    IS NOT NULL;

CREATE TRIGGER trg_sale_lines_no_update BEFORE UPDATE ON sale_lines
BEGIN SELECT RAISE(ABORT, 'sale_lines is immutable'); END;
CREATE TRIGGER trg_sale_lines_no_delete BEFORE DELETE ON sale_lines
BEGIN SELECT RAISE(ABORT, 'sale_lines is immutable'); END;

-- a line must carry the scale its variant has, so a sale can never be priced in the wrong unit
CREATE TRIGGER trg_sale_lines_unit_scale BEFORE INSERT ON sale_lines
WHEN NEW.variant_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'sale_lines: unit_scale must match the variant')
  WHERE NEW.unit_scale <> (SELECT unit_scale FROM accessory_variants WHERE id = NEW.variant_id);
END;

CREATE VIEW v_sale_line_mismatch AS
SELECT s.id AS sale_id, s.subtotal AS subtotal, COALESCE(SUM(l.line_total), 0) AS lines_total
FROM sales s LEFT JOIN sale_lines l ON l.sale_id = s.id
GROUP BY s.id HAVING s.subtotal <> COALESCE(SUM(l.line_total), 0);

CREATE TRIGGER warranties_unit_on_sale
BEFORE INSERT ON warranties
WHEN NOT EXISTS (
  SELECT 1 FROM sale_lines sl JOIN sales s ON s.id = sl.sale_id
  WHERE sl.sale_id = NEW.sale_id AND sl.phone_unit_id = NEW.phone_unit_id AND s.kind = 'sale'
)
BEGIN
  SELECT RAISE(ABORT, 'warranties: the phone unit must be on that sale');
END;
