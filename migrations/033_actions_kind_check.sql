-- nlm:no-wrap
-- Migration 033: CHECK constraint on actions.kind (#294).
--
-- actions.kind has been a freeform TEXT column since 000_initial_schema;
-- the overlay reducer (src/core/actions/overlay.ts) only ever recognizes a
-- fixed set, and unknown kinds silently no-op there instead of failing at
-- write time. This constrains writes to the set the reducer actually
-- understands: dismiss, snooze, retire_entity, label_entity, rename_entity,
-- resolve_open, promote_open, dismiss_decision, revise_decision,
-- merge_entity, set_coherence, plus 'undo' (actions-log.ts's own revert
-- marker, subject_type 'action').
--
-- Adding a CHECK to an existing column requires a table rebuild (SQLite
-- cannot ALTER a CHECK constraint). Runs under foreign_keys=OFF, hence
-- nlm:no-wrap so the runner doesn't add its own BEGIN/COMMIT around this
-- file's own transaction (see migrations/019_split_replaces.sql for the
-- established precedent).

PRAGMA foreign_keys = OFF;

BEGIN;

CREATE TABLE actions_new (
  id                  TEXT PRIMARY KEY,
  timestamp           TEXT NOT NULL,
  kind                TEXT NOT NULL CHECK(kind IN (
                        'dismiss', 'snooze', 'retire_entity', 'label_entity',
                        'rename_entity', 'resolve_open', 'promote_open',
                        'dismiss_decision', 'revise_decision', 'merge_entity',
                        'set_coherence', 'undo'
                      )),
  subject_type        TEXT NOT NULL,
  subject_id          TEXT NOT NULL,
  payload             TEXT,
  actor               TEXT NOT NULL DEFAULT 'user',
  runtime             TEXT,
  reverted_by         TEXT REFERENCES actions(id),
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO actions_new
  (id, timestamp, kind, subject_type, subject_id, payload, actor, runtime, reverted_by, created_at)
SELECT
  id, timestamp, kind, subject_type, subject_id, payload, actor, runtime, reverted_by, created_at
FROM actions;

DROP TABLE actions;
ALTER TABLE actions_new RENAME TO actions;

CREATE INDEX IF NOT EXISTS idx_actions_subject ON actions(subject_type, subject_id);
CREATE INDEX IF NOT EXISTS idx_actions_kind ON actions(kind);
CREATE INDEX IF NOT EXISTS idx_actions_timestamp ON actions(timestamp DESC);

INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (33, 'actions_kind_check');

COMMIT;

PRAGMA foreign_keys = ON;
