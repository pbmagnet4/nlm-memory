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
import { DEFAULT_TEAM_ID } from "../../../../src/core/tenancy/default-team.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../../../migrations");
const T = DEFAULT_TEAM_ID;

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
      const ids = writeActionsBatch(db, T, [dup, dup, { kind: "dismiss", subjectType: "alert", subjectId: "alert_2" }]);
      expect(ids).toHaveLength(2);
      expect(listActions(db, T, { limit: 10 })).toHaveLength(2);
    });
  });

  describe("undo-of-undo guard (#294)", () => {
    it("rejects undoing an 'undo' row", () => {
      const db = storage.sessions.rawDb();
      const id = writeAction(db, T, { kind: "dismiss", subjectType: "alert", subjectId: "alert_1" });
      const undo = undoAction(db, T, id);
      expect(undo).not.toBeNull();
      expect(undoAction(db, T, undo!.undoId)).toBeNull();
    });
  });

  describe("actions.kind CHECK constraint (#294)", () => {
    it("rejects an unknown kind", () => {
      const db = storage.sessions.rawDb();
      expect(() => writeAction(db, T, { kind: "not_a_real_kind", subjectType: "alert", subjectId: "x" })).toThrow(
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
        expect(() => writeAction(db, T, { kind, subjectType: "entity", subjectId: "x" })).not.toThrow();
      }
    });
  });

  describe("tenant isolation (M2 Wave B6)", () => {
    it("listActions never surfaces a session/entity-scoped action row from another tenant", () => {
      const db = storage.sessions.rawDb();
      db.prepare("INSERT OR IGNORE INTO teams (id, name) VALUES (?, ?)").run("team_other", "Other Team");
      db.prepare(
        "INSERT INTO entities (tenant_id, canonical, type, status, session_count, first_seen_session, last_seen_session, created_at, updated_at) " +
          "VALUES (?, 'acme', 'topic', 'active', 0, NULL, NULL, datetime('now'), datetime('now'))",
      ).run(T);
      writeAction(db, T, { kind: "retire_entity", subjectType: "entity", subjectId: "acme" });

      const asOwner = listActions(db, T, { subjectId: "acme" });
      expect(asOwner).toHaveLength(1);
      const asOther = listActions(db, "team_other", { subjectId: "acme" });
      expect(asOther).toHaveLength(0);
    });

    it("listActions still surfaces alert-typed rows for any tenant (no resolvable parent to scope by)", () => {
      const db = storage.sessions.rawDb();
      writeAction(db, T, { kind: "dismiss", subjectType: "alert", subjectId: "alert_shared" });
      expect(listActions(db, T, { subjectId: "alert_shared" })).toHaveLength(1);
      expect(listActions(db, "team_other", { subjectId: "alert_shared" })).toHaveLength(1);
    });

    it("undoAction refuses to undo an entity-scoped action belonging to another tenant", () => {
      const db = storage.sessions.rawDb();
      db.prepare("INSERT OR IGNORE INTO teams (id, name) VALUES (?, ?)").run("team_other", "Other Team");
      db.prepare(
        "INSERT INTO entities (tenant_id, canonical, type, status, session_count, first_seen_session, last_seen_session, created_at, updated_at) " +
          "VALUES (?, 'acme2', 'topic', 'active', 0, NULL, NULL, datetime('now'), datetime('now'))",
      ).run(T);
      const id = writeAction(db, T, { kind: "retire_entity", subjectType: "entity", subjectId: "acme2" });
      expect(undoAction(db, "team_other", id)).toBeNull();
      expect(undoAction(db, T, id)).not.toBeNull();
    });
  });
});
