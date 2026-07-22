/**
 * Migration 018 repair: deletes self-loop 'supersedes' edges and restores
 * sessions wrongly flipped to 'superseded' by the unguarded scan path, while
 * leaving legitimately-superseded sessions (those with a real incoming edge)
 * untouched. Seeds the exact production damage shape on a copy of the migrated
 * schema, applies the repair SQL, and asserts the outcome.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  IngestRecord,
  SqliteSessionStore,
} from "../../src/core/storage/sqlite-session-store.js";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");
const REPAIR_SQL = readFileSync(
  join(MIGRATIONS_DIR, "018_repair_self_supersede.sql"),
  "utf8",
);

function makeRecord(id: string): IngestRecord {
  return {
    id,
    runtime: "claude-code",
    runtimeSessionId: id,
    startedAt: "2026-05-19T10:00:00Z",
    endedAt: "2026-05-19T10:30:00Z",
    durationMin: 30,
    label: "L",
    summary: "S",
    body: "",
    status: "closed",
    transcriptKind: "claude-code-jsonl",
    transcriptPath: null,
    transcriptOffset: null,
    transcriptLength: null,
    entities: [],
    decisions: [],
    openQuestions: [],
    scope: null,
  };
}

describe("migration 018 — repair self-supersedence", () => {
  let tmp: string;
  let storage: SqliteStorage;
  let store: SqliteSessionStore;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-repair-"));
    storage = SqliteStorage.create({
      dbPath: join(tmp, "canonical.sqlite"),
      migrationsDir: MIGRATIONS_DIR,
    });
    await storage.init();
    store = storage.sessions;
  });

  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("drops self-edges, restores self-superseded rows, keeps real supersedence", async () => {
    // damaged: self-loop edge + status flipped to 'superseded' by the bug
    await store.insertSession("team_local", makeRecord("sess_damaged"));
    // legit predecessor that a different session genuinely supersedes
    await store.insertSession("team_local", makeRecord("sess_old"));
    await store.insertSession("team_local", makeRecord("sess_new"));

    const db = store.rawDb();
    db.prepare(
      "INSERT INTO session_edges (from_session, to_session, kind) VALUES (?, ?, 'supersedes')",
    ).run("sess_damaged", "sess_damaged");
    db.prepare("UPDATE sessions SET status = 'superseded' WHERE id = ?").run("sess_damaged");
    db.prepare(
      "INSERT INTO session_edges (from_session, to_session, kind) VALUES (?, ?, 'supersedes')",
    ).run("sess_new", "sess_old");
    db.prepare("UPDATE sessions SET status = 'superseded' WHERE id = ?").run("sess_old");

    db.exec(REPAIR_SQL);

    const selfEdges = db
      .prepare<[], { c: number }>(
        "SELECT COUNT(*) AS c FROM session_edges WHERE from_session = to_session AND kind = 'supersedes'",
      )
      .get();
    expect(selfEdges?.c).toBe(0);

    const statusOf = (id: string) =>
      db
        .prepare<[string], { status: string }>("SELECT status FROM sessions WHERE id = ?")
        .get(id)?.status;
    expect(statusOf("sess_damaged")).toBe("closed");
    expect(statusOf("sess_old")).toBe("superseded");
    expect(statusOf("sess_new")).toBe("closed");
  });
});
