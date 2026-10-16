-- 0001_masters.sql : reference/master data (mutable; synced via outbox, last-write-wins by updated_at)

CREATE TABLE app_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
-- keys written by the app at first run: device_id, tenant_id, invoice_prefix, sync_cursor

CREATE TABLE branches (
  id         TEXT PRIMARY KEY CHECK (length(id) = 36),
  name       TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE users (
  id           TEXT PRIMARY KEY CHECK (length(id) = 36),
  username     TEXT NOT NULL UNIQUE CHECK (length(username) BETWEEN 3 AND 32 AND username = lower(username)),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 100),
  role         TEXT NOT NULL CHECK (role IN ('owner', 'manager', 'cashier')),
  pin_hash     TEXT NOT NULL,
  is_active    INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
) STRICT;

CREATE TABLE customers (
  id           TEXT PRIMARY KEY CHECK (length(id) = 36),
  name         TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  phone        TEXT,
  cnic         TEXT CHECK (cnic IS NULL OR (length(cnic) = 13 AND cnic NOT GLOB '*[^0-9]*')),
  address      TEXT,
  credit_limit INTEGER CHECK (credit_limit IS NULL OR credit_limit >= 0), -- NULL = no limit
  notes        TEXT,
  is_active    INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
) STRICT;
CREATE INDEX ix_customers_name  ON customers (name);
CREATE INDEX ix_customers_phone ON customers (phone);

CREATE TABLE suppliers (
  id         TEXT PRIMARY KEY CHECK (length(id) = 36),
  name       TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  phone      TEXT,
  address    TEXT,
  notes      TEXT,
  is_active  INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX ix_suppliers_name ON suppliers (name);

CREATE TABLE products (
  id         TEXT PRIMARY KEY CHECK (length(id) = 36),
  kind       TEXT NOT NULL CHECK (kind IN ('phone', 'accessory')),
  brand      TEXT NOT NULL CHECK (length(brand) BETWEEN 1 AND 60),
  name       TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  category   TEXT,
  is_active  INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX ix_products_kind_name ON products (kind, name);

-- One row per physical handset. A unit re-acquired later (trade-in, customer return)
-- reuses its row: its movements go +1, -1, +1.
CREATE TABLE phone_units (
  id                 TEXT PRIMARY KEY CHECK (length(id) = 36),
  product_id         TEXT NOT NULL REFERENCES products (id),
  imei1              TEXT CHECK (imei1 IS NULL OR (length(imei1) = 15 AND imei1 NOT GLOB '*[^0-9]*')),
  imei2              TEXT CHECK (imei2 IS NULL OR (length(imei2) = 15 AND imei2 NOT GLOB '*[^0-9]*')),
  serial             TEXT CHECK (serial IS NULL OR length(serial) BETWEEN 1 AND 64),
  colour             TEXT,
  storage_gb         INTEGER CHECK (storage_gb IS NULL OR storage_gb > 0),
  ram_gb             INTEGER CHECK (ram_gb IS NULL OR ram_gb > 0),
  battery_health_pct INTEGER CHECK (battery_health_pct IS NULL OR battery_health_pct BETWEEN 0 AND 100),
  pta_status         TEXT NOT NULL CHECK (pta_status IN ('approved', 'non_pta', 'jv')),
  condition          TEXT NOT NULL CHECK (condition IN ('new', 'used', 'open_box')),
  cost_price         INTEGER NOT NULL CHECK (cost_price >= 0),
  sale_price         INTEGER NOT NULL CHECK (sale_price >= 0),
  supplier_id        TEXT REFERENCES suppliers (id),
  note               TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  CHECK (imei1 IS NOT NULL OR serial IS NOT NULL),
  CHECK (imei2 IS NULL OR imei1 IS NOT NULL),
  CHECK (imei1 IS NULL OR imei2 IS NULL OR imei1 <> imei2)
) STRICT;
CREATE UNIQUE INDEX ux_phone_units_imei1  ON phone_units (imei1)  WHERE imei1  IS NOT NULL;
CREATE UNIQUE INDEX ux_phone_units_imei2  ON phone_units (imei2)  WHERE imei2  IS NOT NULL;
CREATE UNIQUE INDEX ux_phone_units_serial ON phone_units (serial) WHERE serial IS NOT NULL;
CREATE INDEX ix_phone_units_product ON phone_units (product_id);

CREATE TABLE accessory_variants (
  id            TEXT PRIMARY KEY CHECK (length(id) = 36),
  product_id    TEXT NOT NULL REFERENCES products (id),
  sku           TEXT NOT NULL UNIQUE CHECK (length(sku) BETWEEN 1 AND 64),
  barcode       TEXT CHECK (barcode IS NULL OR length(barcode) BETWEEN 1 AND 64),
  model         TEXT, -- compatible handset model, e.g. 'iPhone 15'
  colour        TEXT,
  cost_price    INTEGER NOT NULL CHECK (cost_price >= 0),
  sale_price    INTEGER NOT NULL CHECK (sale_price >= 0),
  reorder_level INTEGER NOT NULL DEFAULT 0 CHECK (reorder_level >= 0),
  is_active     INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX ux_variants_barcode ON accessory_variants (barcode) WHERE barcode IS NOT NULL;
CREATE INDEX ix_variants_product ON accessory_variants (product_id);
