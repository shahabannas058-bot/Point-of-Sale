-- 0003_sales_ledger.sql : immutable hash-chained invoices, payments, khata ledger.
-- Sign convention: kind='sale' has positive amounts/quantities; kind='return'|'void' has negative ones.

CREATE TABLE sales (
  id               TEXT PRIMARY KEY CHECK (length(id) = 36),
  device_id        TEXT NOT NULL CHECK (length(device_id) = 36),
  seq              INTEGER NOT NULL CHECK (seq >= 1),
  invoice_no       TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('sale', 'return', 'void')),
  original_sale_id TEXT REFERENCES sales (id),
  branch_id        TEXT NOT NULL REFERENCES branches (id),
  customer_id      TEXT REFERENCES customers (id),
  cashier_id       TEXT NOT NULL REFERENCES users (id),
  subtotal         INTEGER NOT NULL,
  discount_total   INTEGER NOT NULL DEFAULT 0,
  total            INTEGER NOT NULL,
  note             TEXT,
  created_at       INTEGER NOT NULL,
  hash_version     INTEGER NOT NULL DEFAULT 1,
  prev_hash        TEXT NOT NULL CHECK (length(prev_hash) = 64),
  hash             TEXT NOT NULL CHECK (length(hash) = 64),
  UNIQUE (device_id, seq),
  UNIQUE (device_id, invoice_no),
  UNIQUE (hash),
  CHECK (total = subtotal - discount_total),
  CHECK (
    (kind = 'sale' AND original_sale_id IS NULL AND subtotal >= 0 AND discount_total >= 0 AND total >= 0) OR
    (kind IN ('return', 'void') AND original_sale_id IS NOT NULL AND subtotal <= 0 AND discount_total <= 0 AND total <= 0)
  )
) STRICT;
CREATE INDEX ix_sales_created  ON sales (created_at);
CREATE INDEX ix_sales_customer ON sales (customer_id, created_at);
CREATE INDEX ix_sales_original ON sales (original_sale_id);

CREATE TABLE sale_lines (
  id              TEXT PRIMARY KEY CHECK (length(id) = 36),
  sale_id         TEXT NOT NULL REFERENCES sales (id),
  line_no         INTEGER NOT NULL CHECK (line_no >= 1),
  product_id      TEXT NOT NULL REFERENCES products (id),
  phone_unit_id   TEXT REFERENCES phone_units (id),
  variant_id      TEXT REFERENCES accessory_variants (id),
  description     TEXT NOT NULL,
  quantity        INTEGER NOT NULL CHECK (quantity <> 0),
  unit_price      INTEGER NOT NULL CHECK (unit_price >= 0),
  cost_price      INTEGER NOT NULL CHECK (cost_price >= 0), -- snapshot, for profit reports
  discount_amount INTEGER NOT NULL DEFAULT 0,
  line_total      INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,
  UNIQUE (sale_id, line_no),
  CHECK ((phone_unit_id IS NOT NULL) <> (variant_id IS NOT NULL)),
  CHECK (phone_unit_id IS NULL OR quantity IN (-1, 1)),
  CHECK (line_total = quantity * unit_price - discount_amount)
) STRICT;
CREATE INDEX ix_sale_lines_unit    ON sale_lines (phone_unit_id) WHERE phone_unit_id IS NOT NULL;
CREATE INDEX ix_sale_lines_variant ON sale_lines (variant_id)    WHERE variant_id    IS NOT NULL;

CREATE TABLE payments (
  id         TEXT PRIMARY KEY CHECK (length(id) = 36),
  sale_id    TEXT NOT NULL REFERENCES sales (id),
  method     TEXT NOT NULL CHECK (method IN ('cash', 'khata', 'jazzcash', 'easypaisa', 'bank_transfer', 'card')),
  amount     INTEGER NOT NULL CHECK (amount <> 0),
  reference  TEXT,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX ix_payments_sale ON payments (sale_id);

CREATE TABLE ledger_entries (
  id          TEXT PRIMARY KEY CHECK (length(id) = 36),
  customer_id TEXT REFERENCES customers (id),
  supplier_id TEXT REFERENCES suppliers (id),
  type        TEXT NOT NULL CHECK (type IN (
                'sale_credit', 'payment_received', 'return_credit',
                'purchase_credit', 'payment_made', 'purchase_return',
                'opening_balance', 'adjustment')),
  amount      INTEGER NOT NULL CHECK (amount <> 0),
  method      TEXT CHECK (method IS NULL OR method IN ('cash', 'jazzcash', 'easypaisa', 'bank_transfer', 'card')),
  sale_id     TEXT REFERENCES sales (id),
  purchase_id TEXT REFERENCES purchases (id),
  note        TEXT,
  created_by  TEXT NOT NULL REFERENCES users (id),
  created_at  INTEGER NOT NULL,
  CHECK ((customer_id IS NOT NULL) <> (supplier_id IS NOT NULL)),
  CHECK (customer_id IS NULL OR type IN ('sale_credit', 'payment_received', 'return_credit', 'opening_balance', 'adjustment')),
  CHECK (supplier_id IS NULL OR type IN ('purchase_credit', 'payment_made', 'purchase_return', 'opening_balance', 'adjustment')),
  CHECK (type NOT IN ('sale_credit', 'purchase_credit') OR amount > 0),
  CHECK (type NOT IN ('payment_received', 'return_credit', 'payment_made', 'purchase_return') OR amount < 0)
) STRICT;
CREATE INDEX ix_ledger_customer ON ledger_entries (customer_id, created_at) WHERE customer_id IS NOT NULL;
CREATE INDEX ix_ledger_supplier ON ledger_entries (supplier_id, created_at) WHERE supplier_id IS NOT NULL;

-- Chain linkage enforced in the DB (hash correctness is verified by @pos/core verifyChain).
CREATE TRIGGER trg_sales_chain_guard BEFORE INSERT ON sales
BEGIN
  SELECT RAISE(ABORT, 'sales: seq must be previous seq + 1 for this device')
  WHERE NEW.seq <> COALESCE((SELECT MAX(seq) FROM sales WHERE device_id = NEW.device_id), 0) + 1;
  SELECT RAISE(ABORT, 'sales: prev_hash must equal the hash of the previous invoice')
  WHERE NEW.prev_hash <> COALESCE(
    (SELECT hash FROM sales WHERE device_id = NEW.device_id AND seq = NEW.seq - 1),
    '0000000000000000000000000000000000000000000000000000000000000000');
END;

CREATE TRIGGER trg_sales_original_guard BEFORE INSERT ON sales
WHEN NEW.original_sale_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'sales: original_sale_id must reference a kind=sale invoice')
  WHERE (SELECT kind FROM sales WHERE id = NEW.original_sale_id) IS NOT 'sale';
END;

CREATE TRIGGER trg_payments_khata_guard BEFORE INSERT ON payments
WHEN NEW.method = 'khata'
BEGIN
  SELECT RAISE(ABORT, 'payments: khata requires a sale with a customer')
  WHERE (SELECT customer_id FROM sales WHERE id = NEW.sale_id) IS NULL;
END;

-- Immutability
CREATE TRIGGER trg_sales_no_update BEFORE UPDATE ON sales
BEGIN SELECT RAISE(ABORT, 'sales is immutable: corrections are return/void invoices'); END;
CREATE TRIGGER trg_sales_no_delete BEFORE DELETE ON sales
BEGIN SELECT RAISE(ABORT, 'sales is immutable: corrections are return/void invoices'); END;
CREATE TRIGGER trg_sale_lines_no_update BEFORE UPDATE ON sale_lines
BEGIN SELECT RAISE(ABORT, 'sale_lines is immutable'); END;
CREATE TRIGGER trg_sale_lines_no_delete BEFORE DELETE ON sale_lines
BEGIN SELECT RAISE(ABORT, 'sale_lines is immutable'); END;
CREATE TRIGGER trg_payments_no_update BEFORE UPDATE ON payments
BEGIN SELECT RAISE(ABORT, 'payments is immutable'); END;
CREATE TRIGGER trg_payments_no_delete BEFORE DELETE ON payments
BEGIN SELECT RAISE(ABORT, 'payments is immutable'); END;
CREATE TRIGGER trg_ledger_entries_no_update BEFORE UPDATE ON ledger_entries
BEGIN SELECT RAISE(ABORT, 'ledger_entries is append-only: add an adjustment entry instead'); END;
CREATE TRIGGER trg_ledger_entries_no_delete BEFORE DELETE ON ledger_entries
BEGIN SELECT RAISE(ABORT, 'ledger_entries is append-only: add an adjustment entry instead'); END;

-- Derived views and integrity checks (rows returned = problems)
-- Customer balance: positive = customer owes the shop. Supplier balance: positive = shop owes the supplier.
CREATE VIEW v_customer_balance AS
SELECT customer_id, SUM(amount) AS balance FROM ledger_entries WHERE customer_id IS NOT NULL GROUP BY customer_id;
CREATE VIEW v_supplier_balance AS
SELECT supplier_id, SUM(amount) AS balance FROM ledger_entries WHERE supplier_id IS NOT NULL GROUP BY supplier_id;

CREATE VIEW v_sale_payment_mismatch AS
SELECT s.id AS sale_id, s.total AS total, COALESCE(SUM(p.amount), 0) AS paid
FROM sales s LEFT JOIN payments p ON p.sale_id = s.id
GROUP BY s.id HAVING s.total <> COALESCE(SUM(p.amount), 0);

CREATE VIEW v_sale_line_mismatch AS
SELECT s.id AS sale_id, s.subtotal AS subtotal, COALESCE(SUM(l.line_total), 0) AS lines_total
FROM sales s LEFT JOIN sale_lines l ON l.sale_id = s.id
GROUP BY s.id HAVING s.subtotal <> COALESCE(SUM(l.line_total), 0);
