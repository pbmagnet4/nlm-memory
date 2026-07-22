import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../../../../src/core/storage/sqlite-storage.js";
import {
  dedupeActionInputs,
  listActions,
  undoAction,
  writeAction,
  writeActionsBatch,
} from "../../../../src/core/actions/actions-log.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../../../migrations");

describe("actions-log", () => {
  let tmp: string;
  let storage: SqliteStorage;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-actions-log-"));
    storage = SqliteStorage.create({ dbPath: join(tmp, "c.sqlite"), migrationsDir: MIGRATIONS_DIR });
    await storage.init();
  });

  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  describe("dedupeActionInputs / writeActionsBatch (#294)", () => {
    it("collapses identical rows (same kind + subjectType + subjectId + payload)", () => {
      const dup = { kind: "dismiss", subjectType: "alert", subjectId: "alert_1", payload: { reason: "noise" } };
      expect(dedupeActionInputs([dup, dup])).toHaveLength(1);
    });

    it("does not collapse rows that differ on any field", () => {
      const base = { kind: "dismiss", subjectType: "alert", subjectId: "alert_1" };
      expect(dedupeActionInputs([base, { ...base, subjectId: "alert_2" }])).toHaveLength(2);
      expect(dedupeActionInputs([base, { ...base, payload: { reason: "x" } }])).toHaveLength(2);
    });

    it("writeActionsBatch inserts only one row for duplicates arriving in the same batch", () => {
      const db = storage.sessions.rawDb();
      const dup = { kind: "dismiss", subjectType: "alert", subjectId: "alert_1", payload: { reason: "noise" } };
      const ids = writeActionsBatch(db, [dup, dup, { kind: "dismiss", subjectType: "alert", subjectId: "alert_2" }]);
      expect(ids).toHaveLength(2);
      expect(listActions(db, { limit: 10 })).toHaveLength(2);
    });
  });

  describe("undo-of-undo guard (#294)", () => {
    it("rejects undoing an 'undo' row", () => {
      const db = storage.sessions.rawDb();
      const id = writeAction(db, { kind: "dismiss", subjectType: "alert", subjectId: "alert_1" });
      const undo = undoAction(db, id);
      expect(undo).not.toBeNull();
      expect(undoAction(db, undo!.undoId)).toBeNull();
    });
  });

  describe("actions.kind CHECK constraint (#294)", () => {
    it("rejects an unknown kind", () => {
      const db = storage.sessions.rawDb();
      expect(() => writeAction(db, { kind: "not_a_real_kind", subjectType: "alert", subjectId: "x" })).toThrow(
        /CHECK constraint failed/,
      );
    });

    it("accepts every kind the overlay reducer recognizes", () => {
      const db = storage.sessions.rawDb();
      const knownKinds = [
        "dismiss", "snooze", "retire_entity", "label_entity", "rename_entity",
        "resolve_open", "promote_open", "dismiss_decision", "revise_decision",
        "merge_entity", "set_coherence", "undo",
      ];
      for (const kind of knownKinds) {
        expect(() => writeAction(db, { kind, subjectType: "entity", subjectId: "x" })).not.toThrow();
      }
    });
  });
});
