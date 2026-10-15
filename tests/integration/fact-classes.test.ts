/** Fact classes (T737 / E6): event predicates are exempt from I5a and, with NLM_FACT_CLASSES=on, never superseded on ingest. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Fact } from "../../src/shared/types.js";
import type { IngestRecord, SqliteSessionStore } from "../../src/core/storage/sqlite-session-store.js";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import { EVENT_CLASS_PREDICATES, factClassOf } from "../../src/core/facts/fact-classes.js";
import { PREDICATE_VOCABULARY } from "../../src/core/classifier/prompt.js";
import { countActiveFactConflicts } from "../../src/core/integrity/check-invariants.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

const record = (id: string, startedAt: string): IngestRecord => ({
  id, runtime: "claude-code", runtimeSessionId: id, startedAt, endedAt: startedAt, durationMin: 1,
  label: "L", summary: "S", body: "b", status: "closed", transcriptKind: "claude-code-jsonl",
  transcriptPath: null, transcriptOffset: null, transcriptLength: null,
  entities: [], decisions: [], openQuestions: [], scope: null,
});

const fact = (id: string, sid: string, predicate: string, at: string): Fact => ({
  id, kind: "attribute", subject: "svc", predicate, value: `v-${id}`, sourceSessionId: sid,
  sourceQuote: null, createdAt: at, supersededBy: null, confidence: 0.9,
});

describe("factClassOf", () => {
  it("maps the table, defaults in-vocab predicates to state and unknown strings to event", () => {
    for (const p of EVENT_CLASS_PREDICATES) expect(factClassOf(p)).toBe("event");
    expect(factClassOf("status")).toBe("state");
    expect(factClassOf("port")).toBe("state");
    expect(factClassOf("not-in-vocab")).toBe("event");
  });

  it("only names predicates of the closed vocabulary", () => {
    for (const p of EVENT_CLASS_PREDICATES) expect(PREDICATE_VOCABULARY as readonly string[]).toContain(p);
  });
});

describe("fact classes on ingest", () => {
  let tmp: string;
  let storage: SqliteStorage;
  let store: SqliteSessionStore;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-fc-"));
    storage = SqliteStorage.create({ dbPath: join(tmp, "canonical.sqlite"), migrationsDir: MIGRATIONS_DIR });
    await storage.init();
    store = storage.sessions;
  });

  afterEach(async () => {
    delete process.env["NLM_FACT_CLASSES"];
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  async function ingestTwoSessions(predicate: string): Promise<void> {
    for (const [sid, at] of [["s1", "2026-05-01T10:00:00Z"], ["s2", "2026-05-02T10:00:00Z"]] as const) {
      await store.insertSession("team_local", record(sid, at));
      await store.insertFactsForSession("team_local", sid, storage.facts, [fact(`f_${sid}`, sid, predicate, at)], null);
    }
  }

  const active = (): number =>
    store.rawDb().prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM facts WHERE superseded_by IS NULL").get()!.c;

  it("default (flag off): an event predicate still collapses to the latest", async () => {
    await ingestTwoSessions("version");
    expect(active()).toBe(1);
  });

  it("flag on: an event predicate keeps every fact active", async () => {
    process.env["NLM_FACT_CLASSES"] = "on";
    await ingestTwoSessions("version");
    expect(active()).toBe(2);
  });

  it("flag on: a state predicate still keeps only the latest", async () => {
    process.env["NLM_FACT_CLASSES"] = "on";
    await ingestTwoSessions("status");
    expect(active()).toBe(1);
  });

  it("flag on: two event facts in one batch both survive", async () => {
    process.env["NLM_FACT_CLASSES"] = "on";
    await store.insertSession("team_local", record("s1", "2026-05-01T10:00:00Z"));
    await store.insertFactsForSession("team_local", "s1", storage.facts, [
      fact("a", "s1", "endpoint", "2026-05-01T10:00:00Z"),
      fact("b", "s1", "endpoint", "2026-05-01T10:00:01Z"),
    ], null);
    expect(active()).toBe(2);
  });

  it("I5a does not count event-class groups but still counts state-class groups", async () => {
    await store.insertSession("team_local", record("s1", "2026-05-01T10:00:00Z"));
    await storage.facts.insertMany("team_local", [
      fact("e1", "s1", "runtime", "2026-05-01T10:00:00Z"),
      fact("e2", "s1", "runtime", "2026-05-01T10:00:01Z"),
      fact("s1a", "s1", "status", "2026-05-01T10:00:00Z"),
      fact("s2a", "s1", "status", "2026-05-01T10:00:01Z"),
    ]);
    expect(countActiveFactConflicts(store.rawDb())).toEqual({ conflicts: 1, multiValuedGroups: 1 });
  });
});
