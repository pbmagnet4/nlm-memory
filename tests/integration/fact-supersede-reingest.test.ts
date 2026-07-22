/**
 * Reproduces NLM #301: duplicate active facts on the SQLite ingest path.
 *
 * The SQLite supersedence loop superseded only the single most-recent active
 * prior per new fact (`ORDER BY created_at DESC LIMIT 1`). Once two facts for
 * the same (subject, predicate) were simultaneously active — from a multi-pass
 * backfill, or an `ON DELETE SET NULL` un-supersede when a re-ingest deleted a
 * chain head — every subsequent ingest cleared only one, so the duplicate
 * persisted forever. The PG path already collapsed ALL priors set-wise; the
 * fix brings the three SQLite paths to parity.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Fact } from "../../src/shared/types.js";
import type {
  IngestRecord,
  SqliteSessionStore,
} from "../../src/core/storage/sqlite-session-store.js";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

function makeRecord(id: string, startedAt: string): IngestRecord {
  return {
    id,
    runtime: "claude-code",
    runtimeSessionId: id,
    startedAt,
    endedAt: startedAt,
    durationMin: 1,
    label: "L",
    summary: "S",
    body: "b",
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

function makeFact(id: string, sessionId: string, createdAt: string): Fact {
  return {
    id,
    kind: "attribute",
    subject: "builder-engine",
    predicate: "status",
    value: `status as of ${createdAt}`,
    sourceSessionId: sessionId,
    sourceQuote: null,
    createdAt,
    supersededBy: null,
    confidence: 0.9,
  };
}

describe("fact supersedence survives a re-ingest pass", () => {
  let tmp: string;
  let storage: SqliteStorage;
  let store: SqliteSessionStore;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-301-"));
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

  it("chains a chronological re-ingest down to one active fact", async () => {
    // Baseline: three sessions assert the same pair in started_at order. Each
    // ingest must collapse all prior actives, leaving exactly one.
    const sessions = [
      { sid: "sess_a", at: "2026-04-15T16:17:00Z" },
      { sid: "sess_b", at: "2026-04-15T16:55:00Z" },
      { sid: "sess_c", at: "2026-04-15T17:05:00Z" },
    ];
    for (const s of sessions) await store.insertSession("team_local", makeRecord(s.sid, s.at));
    for (const s of sessions) {
      await store.insertFactsForSession( "team_local",
        s.sid, storage.facts, [makeFact(`fact_${s.sid}`, s.sid, s.at)], null);
    }

    const db = store.rawDb();
    expect(
      db.prepare<[], { c: number }>(
        "SELECT COUNT(*) AS c FROM facts WHERE superseded_by IS NULL",
      ).get()?.c,
    ).toBe(1);
  });

  it("collapses ALL active priors, not just the newest (the #301 defect)", async () => {
    // Construct the exact production shape: two facts simultaneously active for
    // the same (subject, predicate) — created out of order across backfill
    // passes — then ingest a third. The loop's `ORDER BY created_at DESC LIMIT
    // 1` catches only the newest, leaving the other active. Two actives remain.
    await store.insertSession("team_local", makeRecord("sess_x", "2026-04-15T16:17:00Z"));
    await store.insertSession("team_local", makeRecord("sess_y", "2026-04-15T16:21:00Z"));
    await store.insertSession("team_local", makeRecord("sess_z", "2026-04-15T17:05:00Z"));

    const db = store.rawDb();
    const factStore = storage.facts;

    // Seed two ACTIVE facts directly (mirrors the corpus: an earlier pass left
    // fact_y active, a later pass inserted fact_x without superseding it
    // because, at that moment, fact_y was not yet present / the chain was
    // broken by an ON DELETE SET NULL un-supersede).
    await factStore.insertMany("team_local", [
      makeFact("fact_x", "sess_x", "2026-04-15T16:17:00Z"),
      makeFact("fact_y", "sess_y", "2026-04-15T16:21:00Z"),
    ]);
    expect(
      db.prepare<[], { c: number }>(
        "SELECT COUNT(*) AS c FROM facts WHERE superseded_by IS NULL",
      ).get()?.c,
    ).toBe(2);

    // A live ingest of sess_z asserts the same pair. A correct supersedence
    // rule collapses ALL prior actives under the new fact, restoring the
    // invariant. The current loop supersedes only one.
    await store.insertFactsForSession( "team_local",
      "sess_z", factStore, [makeFact("fact_z", "sess_z", "2026-04-15T17:05:00Z")], null);

    const dup = db
      .prepare<[], { bad: string }>(
        `SELECT MIN(id) AS bad FROM facts WHERE superseded_by IS NULL
         GROUP BY subject, predicate HAVING COUNT(*) > 1`,
      )
      .all();
    expect(dup).toEqual([]);
  });
});
