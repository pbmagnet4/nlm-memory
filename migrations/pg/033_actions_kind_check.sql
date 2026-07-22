-- Mirrors migrations/033_actions_kind_check.sql (#294). Pg supports adding a
-- CHECK constraint in place, no table rebuild needed. Same fixed set the
-- overlay reducer (src/core/actions/overlay.ts) understands, plus 'undo'
-- (actions-log.ts's own revert marker, subject_type 'action').

BEGIN;

ALTER TABLE actions DROP CONSTRAINT IF EXISTS actions_kind_check;
ALTER TABLE actions ADD CONSTRAINT actions_kind_check
  CHECK (kind IN (
    'dismiss', 'snooze', 'retire_entity', 'label_entity',
    'rename_entity', 'resolve_open', 'promote_open',
    'dismiss_decision', 'revise_decision', 'merge_entity',
    'set_coherence', 'undo'
  ));

COMMIT;
