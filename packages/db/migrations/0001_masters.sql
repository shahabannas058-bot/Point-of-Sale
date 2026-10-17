-- Master data: shop meta, branches, users, catalog, parties.
-- Money columns are INTEGER paisa. Timestamps are INTEGER epoch milliseconds. Ids are UUID v7 text.

CREATE TABLE app_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE branches (
  id         TEXT    PRIMARY KEY,
  name       TEXT    NOT NULL CHECK (length(trim(name)) > 0),
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE users (
  id           TEXT    PRIMARY KEY,
  username     TEXT    NOT NULL UNIQUE,
  display_name TEXT    NOT NULL,
  role         TEXT    NOT NULL CHECK (role IN ('owner', 'manager', 'cashier')),
  pin_hash     TEXT    NOT NULL,
  is_active    INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
) STRICT;

CREATE TABLE products (
  id         TEXT    PRIMARY KEY,
  kind       TEXT    NOT NULL CHECK (kind IN ('phone', 'accessory')),
  brand      TEXT    NOT NULL,
  name       TEXT    NOT NULL CHECK (length(trim(name)) > 0),
  category   TEXT,
  is_active  INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE INDEX products_kind_name ON products (kind, brand, name);

CREATE TABLE suppliers (
  id         TEXT    PRIMARY KEY,
  name       TEXT    NOT NULL CHECK (length(trim(name)) > 0),
  phone      TEXT,
  address    TEXT,
  notes      TEXT,
  is_active  INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE customers (
  id           TEXT    PRIMARY KEY,
  name         TEXT    NOT NULL CHECK (length(trim(name)) > 0),
  phone        TEXT,
  cnic         TEXT    CHECK (cnic IS NULL OR (length(cnic) = 13 AND cnic NOT GLOB '*[^0-9]*')),
  address      TEXT,
  credit_limit INTEGER CHECK (credit_limit IS NULL OR credit_limit >= 0),
  notes        TEXT,
  is_active    INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
) STRICT;

CREATE INDEX customers_name ON customers (name);
CREATE INDEX customers_phone ON customers (phone);

-- One row per physical phone. Stock of a unit is the sum of its stock_movements (0 or 1).
CREATE TABLE phone_units (
  id                 TEXT    PRIMARY KEY,
  product_id         TEXT    NOT NULL REFERENCES products (id),
  imei1              TEXT    UNIQUE CHECK (imei1 IS NULL OR (length(imei1) = 15 AND imei1 NOT GLOB '*[^0-9]*')),
  imei2              TEXT    UNIQUE CHECK (imei2 IS NULL OR (length(imei2) = 15 AND imei2 NOT GLOB '*[^0-9]*')),
  serial             TEXT    UNIQUE,
  colour             TEXT,
  storage_gb         INTEGER CHECK (storage_gb IS NULL OR storage_gb > 0),
  ram_gb             INTEGER CHECK (ram_gb IS NULL OR ram_gb > 0),
  battery_health_pct INTEGER CHECK (battery_health_pct IS NULL OR battery_health_pct BETWEEN 0 AND 100),
  pta_status         TEXT    NOT NULL CHECK (pta_status IN ('approved', 'non_pta', 'jv')),
  condition          TEXT    NOT NULL CHECK (condition IN ('new', 'used', 'open_box')),
  cost_price         INTEGER NOT NULL CHECK (cost_price >= 0),
  sale_price         INTEGER NOT NULL CHECK (sale_price >= 0),
  supplier_id        TEXT    REFERENCES suppliers (id),
  note               TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  CHECK (imei1 IS NOT NULL OR serial IS NOT NULL)
) STRICT;

CREATE INDEX phone_units_product ON phone_units (product_id);

-- An IMEI may not appear in imei1 of one unit and imei2 of another.
CREATE TRIGGER phone_units_imei_cross_unique_insert
BEFORE INSERT ON phone_units
WHEN EXISTS (
  SELECT 1 FROM phone_units
  WHERE (NEW.imei1 IS NOT NULL AND imei2 = NEW.imei1) OR (NEW.imei2 IS NOT NULL AND imei1 = NEW.imei2)
)
BEGIN
  SELECT RAISE(ABORT, 'UNIQUE constraint failed: phone_units.imei1');
END;

CREATE TABLE accessory_variants (
  id            TEXT    PRIMARY KEY,
  product_id    TEXT    NOT NULL REFERENCES products (id),
  sku           TEXT    NOT NULL UNIQUE CHECK (length(trim(sku)) > 0),
  barcode       TEXT    UNIQUE,
  model         TEXT,
  colour        TEXT,
  cost_price    INTEGER NOT NULL CHECK (cost_price >= 0),
  sale_price    INTEGER NOT NULL CHECK (sale_price >= 0),
  reorder_level INTEGER NOT NULL DEFAULT 5 CHECK (reorder_level >= 0),
  is_active     INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
) STRICT;

CREATE INDEX accessory_variants_product ON accessory_variants (product_id);
