-- 0004_outbox.sql : sync outbox. Written in the SAME transaction as the data change it describes.
-- payload = JSON of the camelCase contract entity. For entity_type 'sale' the payload is the full Invoice (lines + payments).

CREATE TABLE outbox (
  id          TEXT PRIMARY KEY CHECK (length(id) = 36), -- UUID v7: time-ordered, drain ORDER BY id
  entity_type TEXT NOT NULL CHECK (length(entity_type) BETWEEN 1 AND 40),
  entity_id   TEXT NOT NULL,
  op          TEXT NOT NULL CHECK (op IN ('insert', 'update')),
  payload     TEXT NOT NULL CHECK (json_valid(payload)),
  created_at  INTEGER NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error  TEXT,
  sent_at     INTEGER
) STRICT;
CREATE INDEX ix_outbox_pending ON outbox (id) WHERE sent_at IS NULL;

CREATE TRIGGER trg_outbox_frozen BEFORE UPDATE OF id, entity_type, entity_id, op, payload, created_at ON outbox
BEGIN SELECT RAISE(ABORT, 'outbox: only attempts, last_error and sent_at may change'); END;
CREATE TRIGGER trg_outbox_no_delete_unsent BEFORE DELETE ON outbox
WHEN OLD.sent_at IS NULL
BEGIN SELECT RAISE(ABORT, 'outbox: unsent entries cannot be deleted'); END;
