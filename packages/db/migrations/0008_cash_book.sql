-- 0008_cash_book.sql : the cash drawer (galla). Expenses and other cash in / out, and day closes.
-- Cash from sales, udhaar payments, supplier payments and repairs is NOT copied here: a day close reads it from
-- payments / ledger_entries / repair_payments (method = 'cash') and stores the totals as a snapshot.

CREATE TABLE cash_entries (
  id          TEXT PRIMARY KEY CHECK (length(id) = 36),
  branch_id   TEXT NOT NULL REFERENCES branches (id),
  type        TEXT NOT NULL CHECK (type IN ('expense', 'cash_in', 'cash_out')),
  category    TEXT CHECK (category IS NULL OR category IN (
                'rent', 'salary', 'bills', 'tea_food', 'transport', 'maintenance', 'other')),
  -- Positive. A reversal is the negative twin of the entry it cancels (same type and category).
  amount      INTEGER NOT NULL CHECK (amount <> 0),
  note        TEXT CHECK (note IS NULL OR length(note) <= 500),
  reverses_id TEXT UNIQUE REFERENCES cash_entries (id),
  created_by  TEXT NOT NULL REFERENCES users (id),
  created_at  INTEGER NOT NULL,
  CHECK ((type = 'expense') = (category IS NOT NULL)),
  CHECK ((reverses_id IS NULL) = (amount > 0))
) STRICT;
CREATE INDEX ix_cash_entries_created ON cash_entries (branch_id, created_at);

CREATE TRIGGER trg_cash_entries_reversal_guard BEFORE INSERT ON cash_entries
WHEN NEW.reverses_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'cash_entries: a reversal must be the exact negative of an original entry')
  WHERE NOT EXISTS (
    SELECT 1 FROM cash_entries o
    WHERE o.id = NEW.reverses_id AND o.reverses_id IS NULL AND o.amount = -NEW.amount
      AND o.type = NEW.type AND o.category IS NEW.category AND o.branch_id = NEW.branch_id
  );
END;

CREATE TRIGGER trg_cash_entries_no_update BEFORE UPDATE ON cash_entries
BEGIN SELECT RAISE(ABORT, 'cash_entries is append-only: reverse the entry instead'); END;
CREATE TRIGGER trg_cash_entries_no_delete BEFORE DELETE ON cash_entries
BEGIN SELECT RAISE(ABORT, 'cash_entries is append-only: reverse the entry instead'); END;

-- One row per drawer close. A close covers [period_start, closed_at): period_start is the previous close's
-- closed_at (0 for the first) and opening is the cash the previous close left in the drawer.
CREATE TABLE day_closes (
  id               TEXT PRIMARY KEY CHECK (length(id) = 36),
  branch_id        TEXT NOT NULL REFERENCES branches (id),
  period_start     INTEGER NOT NULL CHECK (period_start >= 0),
  closed_at        INTEGER NOT NULL,
  opening          INTEGER NOT NULL CHECK (opening >= 0),
  cash_sales       INTEGER NOT NULL CHECK (cash_sales >= 0),
  cash_refunds     INTEGER NOT NULL CHECK (cash_refunds >= 0),
  udhaar_collected INTEGER NOT NULL CHECK (udhaar_collected >= 0),
  supplier_paid    INTEGER NOT NULL,
  repair_cash      INTEGER NOT NULL, -- signed: advances and balances in, refunds out
  expenses         INTEGER NOT NULL,
  cash_in          INTEGER NOT NULL,
  cash_out         INTEGER NOT NULL,
  expected         INTEGER NOT NULL,
  counted          INTEGER NOT NULL CHECK (counted >= 0),
  carried_forward  INTEGER NOT NULL CHECK (carried_forward BETWEEN 0 AND counted),
  note             TEXT CHECK (note IS NULL OR length(note) <= 500),
  closed_by        TEXT NOT NULL REFERENCES users (id),
  CHECK (closed_at >= period_start),
  CHECK (expected = opening + cash_sales - cash_refunds + udhaar_collected - supplier_paid + repair_cash
                    - expenses + cash_in - cash_out)
) STRICT;
CREATE INDEX ix_day_closes_branch ON day_closes (branch_id, closed_at);

CREATE TRIGGER trg_day_closes_chain_guard BEFORE INSERT ON day_closes
BEGIN
  SELECT RAISE(ABORT, 'day_closes: period_start must equal the previous close time')
  WHERE NEW.period_start <> COALESCE(
    (SELECT MAX(closed_at) FROM day_closes WHERE branch_id = NEW.branch_id), 0);
  SELECT RAISE(ABORT, 'day_closes: opening must equal the cash the previous close left in the drawer')
  WHERE NEW.opening <> COALESCE(
    (SELECT carried_forward FROM day_closes WHERE branch_id = NEW.branch_id ORDER BY closed_at DESC LIMIT 1), 0);
END;

CREATE TRIGGER trg_day_closes_no_update BEFORE UPDATE ON day_closes
BEGIN SELECT RAISE(ABORT, 'day_closes is append-only'); END;
CREATE TRIGGER trg_day_closes_no_delete BEFORE DELETE ON day_closes
BEGIN SELECT RAISE(ABORT, 'day_closes is append-only'); END;
