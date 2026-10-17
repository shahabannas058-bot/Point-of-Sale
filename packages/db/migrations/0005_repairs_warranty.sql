-- Repair job tickets and per-unit warranties (mobile-shop depth).
-- A ticket row carries its CURRENT status; every change is also appended to repair_status_history, which is
-- never changed. Spare parts consume stock through stock_movements (type 'adjustment', ref_type 'repair',
-- ref_id = ticket id) because the stock_movements.type CHECK in 0002 is locked. Repair money lives in
-- repair_payments (immutable), not in the hash-chained sales tables.

CREATE TABLE repair_tickets (
  id              TEXT    PRIMARY KEY,
  ticket_seq      INTEGER NOT NULL UNIQUE CHECK (ticket_seq >= 1),
  ticket_no       TEXT    NOT NULL UNIQUE,
  branch_id       TEXT    NOT NULL REFERENCES branches (id),
  customer_id     TEXT    REFERENCES customers (id),
  -- Snapshot of the customer (or the walk-in's name / phone) at intake.
  customer_name   TEXT    NOT NULL CHECK (length(trim(customer_name)) > 0),
  customer_phone  TEXT,
  device_brand    TEXT    NOT NULL,
  device_model    TEXT    NOT NULL CHECK (length(trim(device_model)) > 0),
  imei            TEXT    CHECK (imei IS NULL OR (length(imei) = 15 AND imei NOT GLOB '*[^0-9]*')),
  serial          TEXT,
  problem         TEXT    NOT NULL CHECK (length(trim(problem)) > 0),
  condition_notes TEXT,
  accessories     TEXT,
  estimated_cost  INTEGER NOT NULL CHECK (estimated_cost >= 0),
  final_charge    INTEGER CHECK (final_charge IS NULL OR final_charge >= 0),
  technician_id   TEXT    REFERENCES users (id),
  promised_at     INTEGER,
  status          TEXT    NOT NULL CHECK (status IN ('received', 'diagnosing', 'in_repair', 'ready', 'delivered', 'cancelled')),
  created_by      TEXT    NOT NULL REFERENCES users (id),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  closed_at       INTEGER,
  CHECK (status <> 'delivered' OR final_charge IS NOT NULL),
  CHECK ((status IN ('delivered', 'cancelled')) = (closed_at IS NOT NULL))
) STRICT;

CREATE INDEX repair_tickets_status ON repair_tickets (status, created_at);
CREATE INDEX repair_tickets_customer ON repair_tickets (customer_id, created_at);
CREATE INDEX repair_tickets_imei ON repair_tickets (imei);

-- Identity columns never change, and a delivered / cancelled ticket is closed for good.
CREATE TRIGGER repair_tickets_identity_fixed
BEFORE UPDATE ON repair_tickets
WHEN NEW.id IS NOT OLD.id OR NEW.ticket_seq IS NOT OLD.ticket_seq OR NEW.ticket_no IS NOT OLD.ticket_no
  OR NEW.branch_id IS NOT OLD.branch_id OR NEW.created_by IS NOT OLD.created_by
  OR NEW.created_at IS NOT OLD.created_at OR OLD.status IN ('delivered', 'cancelled')
BEGIN
  SELECT RAISE(ABORT, 'repair_tickets: a closed ticket or its identity is immutable');
END;

CREATE TRIGGER repair_tickets_no_delete
BEFORE DELETE ON repair_tickets
BEGIN
  SELECT RAISE(ABORT, 'repair_tickets is append-only');
END;

CREATE TABLE repair_status_history (
  id          TEXT    PRIMARY KEY,
  ticket_id   TEXT    NOT NULL REFERENCES repair_tickets (id),
  from_status TEXT    CHECK (from_status IS NULL OR from_status IN ('received', 'diagnosing', 'in_repair', 'ready', 'delivered', 'cancelled')),
  to_status   TEXT    NOT NULL CHECK (to_status IN ('received', 'diagnosing', 'in_repair', 'ready', 'delivered', 'cancelled')),
  note        TEXT,
  changed_by  TEXT    NOT NULL REFERENCES users (id),
  changed_at  INTEGER NOT NULL
) STRICT;

CREATE INDEX repair_status_history_ticket ON repair_status_history (ticket_id, changed_at);

CREATE TRIGGER repair_status_history_no_update
BEFORE UPDATE ON repair_status_history
BEGIN
  SELECT RAISE(ABORT, 'repair_status_history is append-only');
END;

CREATE TRIGGER repair_status_history_no_delete
BEFORE DELETE ON repair_status_history
BEGIN
  SELECT RAISE(ABORT, 'repair_status_history is append-only');
END;

-- Spare parts fitted to a ticket. Each row has a matching stock_movements row (-quantity).
CREATE TABLE repair_parts (
  id                TEXT    PRIMARY KEY,
  ticket_id         TEXT    NOT NULL REFERENCES repair_tickets (id),
  variant_id        TEXT    NOT NULL REFERENCES accessory_variants (id),
  quantity          INTEGER NOT NULL CHECK (quantity > 0),
  unit_cost         INTEGER NOT NULL CHECK (unit_cost >= 0),
  unit_price        INTEGER NOT NULL CHECK (unit_price >= 0),
  stock_movement_id TEXT    NOT NULL UNIQUE REFERENCES stock_movements (id),
  created_by        TEXT    NOT NULL REFERENCES users (id),
  created_at        INTEGER NOT NULL
) STRICT;

CREATE INDEX repair_parts_ticket ON repair_parts (ticket_id);

CREATE TRIGGER repair_parts_no_update
BEFORE UPDATE ON repair_parts
BEGIN
  SELECT RAISE(ABORT, 'repair_parts is append-only');
END;

CREATE TRIGGER repair_parts_no_delete
BEFORE DELETE ON repair_parts
BEGIN
  SELECT RAISE(ABORT, 'repair_parts is append-only');
END;

-- Money for a ticket: advance at intake (+), balance at delivery (+), refund on cancel / overpaid advance (-).
-- Khata is only allowed for the delivery balance of a ticket that has a customer.
CREATE TABLE repair_payments (
  id         TEXT    PRIMARY KEY,
  ticket_id  TEXT    NOT NULL REFERENCES repair_tickets (id),
  kind       TEXT    NOT NULL CHECK (kind IN ('advance', 'balance', 'refund')),
  method     TEXT    NOT NULL CHECK (method IN ('cash', 'khata', 'jazzcash', 'easypaisa', 'bank_transfer', 'card')),
  amount     INTEGER NOT NULL CHECK (amount <> 0),
  reference  TEXT,
  created_by TEXT    NOT NULL REFERENCES users (id),
  created_at INTEGER NOT NULL,
  CHECK ((kind = 'refund') = (amount < 0)),
  CHECK (method <> 'khata' OR kind = 'balance')
) STRICT;

CREATE INDEX repair_payments_ticket ON repair_payments (ticket_id);
CREATE INDEX repair_payments_created ON repair_payments (created_at);

CREATE TRIGGER repair_payments_khata_needs_customer
BEFORE INSERT ON repair_payments
WHEN NEW.method = 'khata' AND (SELECT customer_id FROM repair_tickets WHERE id = NEW.ticket_id) IS NULL
BEGIN
  SELECT RAISE(ABORT, 'repair_payments: khata requires a ticket with a customer');
END;

CREATE TRIGGER repair_payments_no_update
BEFORE UPDATE ON repair_payments
BEGIN
  SELECT RAISE(ABORT, 'repair_payments is append-only');
END;

CREATE TRIGGER repair_payments_no_delete
BEFORE DELETE ON repair_payments
BEGIN
  SELECT RAISE(ABORT, 'repair_payments is append-only');
END;

-- Shop / company warranty on a sold phone unit. Sale lines are hashed, so warranties live beside them.
CREATE TABLE warranties (
  id            TEXT    PRIMARY KEY,
  phone_unit_id TEXT    NOT NULL REFERENCES phone_units (id),
  sale_id       TEXT    NOT NULL REFERENCES sales (id),
  kind          TEXT    NOT NULL CHECK (kind IN ('shop', 'company')),
  starts_at     INTEGER NOT NULL,
  ends_at       INTEGER NOT NULL,
  note          TEXT,
  created_by    TEXT    NOT NULL REFERENCES users (id),
  created_at    INTEGER NOT NULL,
  UNIQUE (sale_id, phone_unit_id, kind),
  CHECK (ends_at > starts_at)
) STRICT;

CREATE INDEX warranties_unit ON warranties (phone_unit_id);
CREATE INDEX warranties_ends ON warranties (ends_at);

CREATE TRIGGER warranties_unit_on_sale
BEFORE INSERT ON warranties
WHEN NOT EXISTS (
  SELECT 1 FROM sale_lines sl JOIN sales s ON s.id = sl.sale_id
  WHERE sl.sale_id = NEW.sale_id AND sl.phone_unit_id = NEW.phone_unit_id AND s.kind = 'sale'
)
BEGIN
  SELECT RAISE(ABORT, 'warranties: the phone unit must be on that sale');
END;

CREATE TRIGGER warranties_no_update
BEFORE UPDATE ON warranties
BEGIN
  SELECT RAISE(ABORT, 'warranties is append-only');
END;

CREATE TRIGGER warranties_no_delete
BEFORE DELETE ON warranties
BEGIN
  SELECT RAISE(ABORT, 'warranties is append-only');
END;
