/**
 * Phase B.4 — deterministic supersedence on (subject, predicate) collision.
 *
 * Drives SqliteSessionStore.insertSession with factSink wired and verifies
 * that prior non-superseded facts get marked superseded_by = newFactId
 * atomically with the session ingest. Tests live at the integration layer
 * because the behavior is inside a SQL transaction.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SqliteFactStore } from "../../src/core/storage/sqlite-fact-store.js";
import type {
  IngestRecord,
  SqliteSessionStore,
} from "../../src/core/storage/sqlite-session-store.js";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import type { Fact } from "../../src/shared/types.js";
import { makeFact } from "../fixtures/facts.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

function makeRecord(overrides: Partial<IngestRecord> = {}): IngestRecord {
  return {
    id: "sess_test",
    runtime: "claude-code",
    runtimeSessionId: "test-1",
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
    ...overrides,
  };
}

function fact(overrides: Partial<Fact>): Fact {
  return makeFact({
    id: `fact_${Math.random().toString(36).slice(2, 10)}`,
    confidence: 0.9,
    ...overrides,
  });
}

describe("Phase B.4 — supersedence-on-ingest", () => {
  let tmp: string;
  let storage: SqliteStorage;
  let store: SqliteSessionStore;
  let factStore: SqliteFactStore;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-b4-"));
    storage = SqliteStorage.create({
      dbPath: join(tmp, "canonical.sqlite"),
      migrationsDir: MIGRATIONS_DIR,
    });
    await storage.init();
    store = storage.sessions;
    factStore = storage.facts;
  });

  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("cross-session collision: new fact supersedes prior current fact for the same (s, p)", async () => {
    // Session A asserts framework=Fastify
    const factA = fact({
      id: "f_A",
      subject: "nlm-memory-ts",
      predicate: "framework",
      value: "Fastify",
      sourceSessionId: "sess_A",
      createdAt: "2026-05-18T10:00:00Z",
    });
    await store.insertSession(
      makeRecord({ id: "sess_A", startedAt: "2026-05-18T10:00:00Z" }),
      null,
      null,
      { factStore, facts: [factA] },
    );

    // Session B asserts framework=Hono
    const factB = fact({
      id: "f_B",
      subject: "nlm-memory-ts",
      predicate: "framework",
      value: "Hono",
      sourceSessionId: "sess_B",
      createdAt: "2026-05-19T10:00:00Z",
    });
    await store.insertSession(
      makeRecord({ id: "sess_B" }),
      null,
      null,
      { factStore, facts: [factB] },
    );

    const fetchedA = await factStore.getById("f_A");
    const fetchedB = await factStore.getById("f_B");
    expect(fetchedA?.supersededBy).toBe("f_B");
    expect(fetchedB?.supersededBy).toBeNull();

    const current = await factStore.findCurrent("nlm-memory-ts", "framework");
    expect(current?.id).toBe("f_B");
    expect(current?.value).toBe("Hono");
  });

  it("no collision when subject differs", async () => {
    await store.insertSession(
      makeRecord({ id: "sess_A" }),
      null, null,
      {
        factStore,
        facts: [fact({ id: "fA", subject: "alpha", predicate: "framework", value: "v", sourceSessionId: "sess_A" })],
      },
    );
    await store.insertSession(
      makeRecord({ id: "sess_B" }),
      null, null,
      {
        factStore,
        facts: [fact({ id: "fB", subject: "beta", predicate: "framework", value: "v", sourceSessionId: "sess_B" })],
      },
    );
    expect((await factStore.getById("fA"))?.supersededBy).toBeNull();
    expect((await factStore.getById("fB"))?.supersededBy).toBeNull();
  });

  it("no collision when predicate differs", async () => {
    await store.insertSession(
      makeRecord({ id: "sess_A" }),
      null, null,
      {
        factStore,
        facts: [fact({ id: "fA", subject: "x", predicate: "framework", value: "v", sourceSessionId: "sess_A" })],
      },
    );
    await store.insertSession(
      makeRecord({ id: "sess_B" }),
      null, null,
      {
        factStore,
        facts: [fact({ id: "fB", subject: "x", predicate: "endpoint", value: "v", sourceSessionId: "sess_B" })],
      },
    );
    expect((await factStore.getById("fA"))?.supersededBy).toBeNull();
    expect((await factStore.getById("fB"))?.supersededBy).toBeNull();
  });

  it("always-supersede policy: same value from a new session still supersedes (provenance changes)", async () => {
    const factA = fact({
      id: "f_A", subject: "x", predicate: "framework", value: "Hono",
      sourceSessionId: "sess_A", createdAt: "2026-05-18T10:00:00Z",
    });
    await store.insertSession(makeRecord({ id: "sess_A", startedAt: "2026-05-18T10:00:00Z" }), null, null,
      { factStore, facts: [factA] });

    const factB = fact({
      id: "f_B", subject: "x", predicate: "framework", value: "Hono",
      sourceSessionId: "sess_B", createdAt: "2026-05-19T10:00:00Z",
    });
    await store.insertSession(makeRecord({ id: "sess_B" }), null, null,
      { factStore, facts: [factB] });

    expect((await factStore.getById("f_A"))?.supersededBy).toBe("f_B");
    expect((await factStore.getById("f_B"))?.supersededBy).toBeNull();
  });

  it("three-deep chain: A → B → C, only the immediate predecessor gets re-linked per ingest", async () => {
    const factA = fact({ id: "f_A", subject: "x", predicate: "framework", value: "Fastify", sourceSessionId: "sess_A", createdAt: "2026-05-17T10:00:00Z" });
    const factB = fact({ id: "f_B", subject: "x", predicate: "framework", value: "Hono", sourceSessionId: "sess_B", createdAt: "2026-05-18T10:00:00Z" });
    const factC = fact({ id: "f_C", subject: "x", predicate: "framework", value: "Elysia", sourceSessionId: "sess_C", createdAt: "2026-05-19T10:00:00Z" });

    await store.insertSession(makeRecord({ id: "sess_A", startedAt: "2026-05-17T10:00:00Z" }), null, null, { factStore, facts: [factA] });
    await store.insertSession(makeRecord({ id: "sess_B", startedAt: "2026-05-18T10:00:00Z" }), null, null, { factStore, facts: [factB] });
    await store.insertSession(makeRecord({ id: "sess_C", startedAt: "2026-05-19T10:00:00Z" }), null, null, { factStore, facts: [factC] });

    expect((await factStore.getById("f_A"))?.supersededBy).toBe("f_B");
    expect((await factStore.getById("f_B"))?.supersededBy).toBe("f_C");
    expect((await factStore.getById("f_C"))?.supersededBy).toBeNull();

    // History walks newest → oldest
    const chains = await factStore.getHistory("x", "framework");
    expect(chains[0]?.history.map((f) => f.id)).toEqual(["f_C", "f_B", "f_A"]);
  });

  it("re-ingest of same session re-establishes the chain (CASCADE-SET-NULL on the old self-fact)", async () => {
    // First, an old session asserts framework=v1
    const oldFact = fact({
      id: "f_old", subject: "x", predicate: "framework", value: "v1",
      sourceSessionId: "sess_old", createdAt: "2026-05-17T10:00:00Z",
    });
    await store.insertSession(
      makeRecord({ id: "sess_old", startedAt: "2026-05-17T10:00:00Z" }),
      null, null, { factStore, facts: [oldFact] },
    );

    // Self session asserts framework=v2 — supersedes f_old
    const selfFactV1 = fact({
      id: "f_self_v1", subject: "x", predicate: "framework", value: "v2",
      sourceSessionId: "sess_self", createdAt: "2026-05-18T10:00:00Z",
    });
    await store.insertSession(
      makeRecord({ id: "sess_self", startedAt: "2026-05-18T10:00:00Z" }),
      null, null, { factStore, facts: [selfFactV1] },
    );
    expect((await factStore.getById("f_old"))?.supersededBy).toBe("f_self_v1");

    // Re-ingest sess_self with a refreshed fact (e.g. classifier produced a
    // new id on a re-classification). The old self fact is wiped via DELETE;
    // ON DELETE SET NULL releases f_old; then the new self fact picks up
    // the collision and re-supersedes f_old.
    const selfFactV2 = fact({
      id: "f_self_v2", subject: "x", predicate: "framework", value: "v2",
      sourceSessionId: "sess_self", createdAt: "2026-05-18T11:00:00Z",
    });
    await store.insertSession(
      makeRecord({ id: "sess_self", startedAt: "2026-05-18T10:00:00Z" }),
      null, null, { factStore, facts: [selfFactV2] },
    );

    expect(await factStore.getById("f_self_v1")).toBeNull(); // deleted
    expect((await factStore.getById("f_old"))?.supersededBy).toBe("f_self_v2");
    expect((await factStore.getById("f_self_v2"))?.supersededBy).toBeNull();

    const current = await factStore.findCurrent("x", "framework");
    expect(current?.id).toBe("f_self_v2");
  });

  it("does not supersede when factSink is omitted", async () => {
    // Pre-seed a fact via the direct factStore API (no session txn route)
    store.insertSessionForTest({
      id: "sess_seed",
      runtime: "claude-code",
      runtimeSessionId: "seed",
      startedAt: "2026-05-18T00:00:00Z",
      endedAt: null,
      durationMin: null,
      label: "seed",
      summary: "",
      status: "closed",
      transcriptKind: "claude-code-jsonl",
      transcriptPath: null,
      body: "",
      entities: [],
      decisions: [],
      open: [],
    });
    await factStore.insert(
      fact({ id: "f_seed", subject: "x", predicate: "framework", value: "v1", sourceSessionId: "sess_seed" }),
    );

    // Insert a session with NO factSink. The seed fact stays current.
    await store.insertSession(makeRecord({ id: "sess_nofacts" }));
    expect((await factStore.getById("f_seed"))?.supersededBy).toBeNull();
  });

  it("multi-fact ingest: each new fact supersedes its own (s, p) predecessor independently", async () => {
    // Two prior facts, different (s, p) pairs
    const sessFirst = "sess_first";
    await store.insertSession(
      makeRecord({ id: sessFirst, startedAt: "2026-05-18T10:00:00Z" }),
      null, null,
      {
        factStore,
        facts: [
          fact({ id: "p1", subject: "a", predicate: "framework", value: "Fastify", sourceSessionId: sessFirst, createdAt: "2026-05-18T10:00:00Z" }),
          fact({ id: "p2", subject: "b", predicate: "endpoint", value: ":8080", sourceSessionId: sessFirst, createdAt: "2026-05-18T10:00:00Z" }),
        ],
      },
    );

    // One ingest delivering supersedents to both
    await store.insertSession(
      makeRecord({ id: "sess_multi", startedAt: "2026-05-19T10:00:00Z" }),
      null, null,
      {
        factStore,
        facts: [
          fact({ id: "n1", subject: "a", predicate: "framework", value: "Hono", sourceSessionId: "sess_multi", createdAt: "2026-05-19T10:00:00Z" }),
          fact({ id: "n2", subject: "b", predicate: "endpoint", value: ":3940", sourceSessionId: "sess_multi", createdAt: "2026-05-19T10:00:00Z" }),
        ],
      },
    );

    expect((await factStore.getById("p1"))?.supersededBy).toBe("n1");
    expect((await factStore.getById("p2"))?.supersededBy).toBe("n2");
    expect((await factStore.getById("n1"))?.supersededBy).toBeNull();
    expect((await factStore.getById("n2"))?.supersededBy).toBeNull();
  });

  it("FactRecallService default minConfidence respects supersedence — only current shows", async () => {
    const factA = fact({ id: "f_old", subject: "x", predicate: "framework", value: "Fastify", sourceSessionId: "sess_A", createdAt: "2026-05-17T10:00:00Z" });
    const factB = fact({ id: "f_new", subject: "x", predicate: "framework", value: "Hono", sourceSessionId: "sess_B", createdAt: "2026-05-19T10:00:00Z" });
    await store.insertSession(makeRecord({ id: "sess_A", startedAt: "2026-05-17T10:00:00Z" }), null, null, { factStore, facts: [factA] });
    await store.insertSession(makeRecord({ id: "sess_B", startedAt: "2026-05-19T10:00:00Z" }), null, null, { factStore, facts: [factB] });

    const current = await factStore.list({ subject: "x", predicate: "framework" });
    expect(current.map((f) => f.id)).toEqual(["f_new"]);

    const all = await factStore.list({ subject: "x", predicate: "framework", includeSuperseded: true });
    expect(all.map((f) => f.id).sort()).toEqual(["f_new", "f_old"]);
  });

  it("re-ingest deletes embeddings of replaced same-session facts — no orphan vectors (#351 follow-up)", async () => {
    const embCount = (factId: string) =>
      storage
        .rawDb()
        .prepare<[string], { c: number }>("SELECT COUNT(*) AS c FROM fact_embeddings WHERE fact_id = ?")
        .get(factId)?.c;

    // First ingest of sess_R lands one fact; give it a vec0 embedding.
    const first = fact({ id: "f_first", subject: "svc", predicate: "port", value: "3940", sourceSessionId: "sess_R" });
    await store.insertSession(makeRecord({ id: "sess_R" }), null, null, { factStore, facts: [first] });
    const v = new Float32Array(768); v[7] = 1;
    await factStore.upsertEmbedding("f_first", v);
    expect(embCount("f_first")).toBe(1);

    // Re-ingest the SAME session id with a different fact: insertSession deletes
    // the prior fact (DELETE FROM facts WHERE source_session_id). Its embedding
    // must go too — otherwise it is an orphan vec0 vector that steals kNN slots.
    const second = fact({ id: "f_second", subject: "svc", predicate: "host", value: "localhost", sourceSessionId: "sess_R" });
    await store.insertSession(makeRecord({ id: "sess_R" }), null, null, { factStore, facts: [second] });

    expect(embCount("f_first")).toBe(0);
  });

  it("insertSession batch with duplicate (subject, predicate) creates no supersedence cycle (#351 bug 2 — production path)", async () => {
    // The live ingest path (scheduler -> insertSession) must collapse a
    // duplicate-(s,p) batch under ONE winner, not per-fact (which makes A->B,
    // B->A — both recall-ineligible forever). The fix lived only in the
    // canonical ingestSessionFacts, which production does not call.
    await store.insertSession(makeRecord({ id: "sess_dup" }), null, null, {
      factStore,
      facts: [
        fact({ id: "d1", subject: "A", predicate: "uses", value: "x", sourceSessionId: "sess_dup" }),
        fact({ id: "d2", subject: "A", predicate: "uses", value: "y", sourceSessionId: "sess_dup" }),
      ],
    });
    const db = storage.rawDb();
    const active = db
      .prepare("SELECT id FROM facts WHERE subject='A' AND predicate='uses' AND superseded_by IS NULL")
      .all();
    expect(active).toHaveLength(1);
    const cyc = db
      .prepare<[], { c: number }>(
        "SELECT COUNT(*) AS c FROM facts a JOIN facts b ON a.superseded_by=b.id AND b.superseded_by=a.id",
      )
      .get();
    expect(cyc?.c).toBe(0);
  });

  it("insertSession cross-session collapse deletes the superseded prior fact's embedding (#351 bug 1 — production path)", async () => {
    const embCount = (factId: string) =>
      storage
        .rawDb()
        .prepare<[string], { c: number }>("SELECT COUNT(*) AS c FROM fact_embeddings WHERE fact_id = ?")
        .get(factId)?.c;

    await store.insertSession(makeRecord({ id: "sess_p1" }), null, null, {
      factStore,
      facts: [fact({ id: "c_old", subject: "M", predicate: "framework", value: "Fastify", sourceSessionId: "sess_p1" })],
    });
    const v = new Float32Array(768); v[9] = 1;
    await factStore.upsertEmbedding("c_old", v);
    expect(embCount("c_old")).toBe(1);

    // A later session asserts the same (subject, predicate): c_old collapses.
    await store.insertSession(makeRecord({ id: "sess_p2", startedAt: "2026-05-20T10:00:00Z" }), null, null, {
      factStore,
      facts: [fact({ id: "c_new", subject: "M", predicate: "framework", value: "Hono", sourceSessionId: "sess_p2" })],
    });
    expect((await factStore.getById("c_old"))?.supersededBy).toBe("c_new");
    expect(embCount("c_old")).toBe(0);
  });
});
