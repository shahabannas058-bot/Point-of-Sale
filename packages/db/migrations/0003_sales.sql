-- Invoices are immutable and hash-chained per device: each row stores the previous invoice's hash.
-- Corrections are new 'return' / 'void' invoices that point at the original sale.

CREATE TABLE sales (
  id               TEXT    PRIMARY KEY,
  device_id        TEXT    NOT NULL,
  seq              INTEGER NOT NULL CHECK (seq >= 1),
  invoice_no       TEXT    NOT NULL UNIQUE,
  kind             TEXT    NOT NULL CHECK (kind IN ('sale', 'return', 'void')),
  original_sale_id TEXT    REFERENCES sales (id),
  branch_id        TEXT    NOT NULL REFERENCES branches (id),
  customer_id      TEXT    REFERENCES customers (id),
  cashier_id       TEXT    NOT NULL REFERENCES users (id),
  subtotal         INTEGER NOT NULL,
  discount_total   INTEGER NOT NULL,
  total            INTEGER NOT NULL,
  note             TEXT,
  created_at       INTEGER NOT NULL,
  hash_version     INTEGER NOT NULL DEFAULT 1,
  prev_hash        TEXT    NOT NULL CHECK (length(prev_hash) = 64),
  hash             TEXT    NOT NULL UNIQUE CHECK (length(hash) = 64),
  UNIQUE (device_id, seq),
  CHECK ((kind = 'sale') = (original_sale_id IS NULL)),
  CHECK (total = subtotal - discount_total)
) STRICT;

CREATE INDEX sales_created ON sales (created_at);
CREATE INDEX sales_customer ON sales (customer_id, created_at);
CREATE INDEX sales_original ON sales (original_sale_id);

CREATE TRIGGER sales_chain_seq
BEFORE INSERT ON sales
WHEN NEW.seq <> COALESCE((SELECT MAX(seq) FROM sales WHERE device_id = NEW.device_id), 0) + 1
BEGIN
  SELECT RAISE(ABORT, 'sales: seq must be previous seq + 1');
END;

CREATE TRIGGER sales_chain_prev_hash
BEFORE INSERT ON sales
WHEN NEW.prev_hash <> COALESCE(
  (SELECT hash FROM sales WHERE device_id = NEW.device_id ORDER BY seq DESC LIMIT 1),
  '0000000000000000000000000000000000000000000000000000000000000000')
BEGIN
  SELECT RAISE(ABORT, 'sales: prev_hash must equal the hash of the previous invoice');
END;

CREATE TRIGGER sales_original_is_sale
BEFORE INSERT ON sales
WHEN NEW.original_sale_id IS NOT NULL
  AND COALESCE((SELECT kind FROM sales WHERE id = NEW.original_sale_id), '') <> 'sale'
BEGIN
  SELECT RAISE(ABORT, 'sales: original_sale_id must reference a sale invoice');
END;

CREATE TRIGGER sales_no_update
BEFORE UPDATE ON sales
BEGIN
  SELECT RAISE(ABORT, 'sales is immutable');
END;

CREATE TRIGGER sales_no_delete
BEFORE DELETE ON sales
BEGIN
  SELECT RAISE(ABORT, 'sales is immutable');
END;

CREATE TABLE sale_lines (
  id              TEXT    PRIMARY KEY,
  sale_id         TEXT    NOT NULL REFERENCES sales (id),
  line_no         INTEGER NOT NULL CHECK (line_no >= 1),
  product_id      TEXT    NOT NULL REFERENCES products (id),
  phone_unit_id   TEXT    REFERENCES phone_units (id),
  variant_id      TEXT    REFERENCES accessory_variants (id),
  description     TEXT    NOT NULL,
  quantity        INTEGER NOT NULL CHECK (quantity <> 0),
  unit_price      INTEGER NOT NULL,
  cost_price      INTEGER NOT NULL,
  discount_amount INTEGER NOT NULL,
  line_total      INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,
  UNIQUE (sale_id, line_no),
  CHECK ((phone_unit_id IS NULL) <> (variant_id IS NULL)),
  CHECK (line_total = unit_price * quantity - discount_amount)
) STRICT;

CREATE INDEX sale_lines_unit ON sale_lines (phone_unit_id);
CREATE INDEX sale_lines_variant ON sale_lines (variant_id);

CREATE TRIGGER sale_lines_no_update
BEFORE UPDATE ON sale_lines
BEGIN
  SELECT RAISE(ABORT, 'sale_lines is immutable');
END;

CREATE TRIGGER sale_lines_no_delete
BEFORE DELETE ON sale_lines
BEGIN
  SELECT RAISE(ABORT, 'sale_lines is immutable');
END;

CREATE TABLE payments (
  id         TEXT    PRIMARY KEY,
  sale_id    TEXT    NOT NULL REFERENCES sales (id),
  method     TEXT    NOT NULL CHECK (method IN ('cash', 'khata', 'jazzcash', 'easypaisa', 'bank_transfer', 'card')),
  amount     INTEGER NOT NULL CHECK (amount <> 0),
  reference  TEXT,
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX payments_sale ON payments (sale_id);

CREATE TRIGGER payments_khata_needs_customer
BEFORE INSERT ON payments
WHEN NEW.method = 'khata' AND (SELECT customer_id FROM sales WHERE id = NEW.sale_id) IS NULL
BEGIN
  SELECT RAISE(ABORT, 'payments: khata requires a sale with a customer');
END;

CREATE TRIGGER payments_no_update
BEFORE UPDATE ON payments
BEGIN
  SELECT RAISE(ABORT, 'payments is immutable');
END;

CREATE TRIGGER payments_no_delete
BEFORE DELETE ON payments
BEGIN
  SELECT RAISE(ABORT, 'payments is immutable');
END;
