/**
 * backfillFacts over the PG backend: seeds sessions (no facts), runs the
 * classifier, and verifies facts land + supersedence fires + reprocess
 * semantics. Proves the offline fact-backfill works on PostgreSQL.
 *
 * Requires a running PostgreSQL instance. Set NLM_PG_TEST_URL. Skips when
 * absent. Tables are truncated between tests.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { PgStorage } from "../../src/core/storage/pg-storage.js";
import { backfillFacts } from "../../src/core/facts/backfill-facts.js";
import type { ClassifyResult, EmbedResult, ExtractedFact, LLMClient } from "../../src/ports/llm-client.js";
import type { Session } from "../../src/shared/types.js";
import { usePgTestSchema } from "../helpers/pg-test-schema.js";

const PG_TEST_URL = process.env["NLM_PG_TEST_URL"];
const MIGRATIONS_DIR = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../migrations/pg",
);
const TRUNCATE_SQL = "TRUNCATE TABLE sessions, facts, fact_embeddings RESTART IDENTITY CASCADE";

class ScriptedClassifier implements LLMClient {
  constructor(private readonly results: Map<string, ClassifyResult>) {}
  async embed(): Promise<EmbedResult> { throw new Error("not used"); }
  async rewriteForRecall(): Promise<never> { throw new Error("not used"); }
  async classify(transcript: string): Promise<ClassifyResult> {
    const r = this.results.get(transcript);
    if (!r) throw new Error(`no scripted result for: ${transcript.slice(0, 40)}`);
    return r;
  }
  nameWorkstream(): Promise<string | null> { throw new Error("stub"); }
}

function classifyResult(facts: ExtractedFact[], confidence = 0.9): ClassifyResult {
  return { label: "L", summary: "S", entities: [], decisions: [], open: [], confidence, facts };
}

function session(id: string, body: string, startedAt: string): Session {
  return {
    id, runtime: "claude-code", runtimeSessionId: id,
    startedAt, endedAt: null, durationMin: null,
    label: "L", summary: "S", status: "closed",
    transcriptKind: "claude-code", transcriptPath: null, body,
    entities: [], decisions: [], open: [],
  };
}

describe.skipIf(!PG_TEST_URL)("backfillFacts (PG backend)", () => {
  const pgUrl = usePgTestSchema(PG_TEST_URL, import.meta.url);
  let storage: PgStorage;
  let pool: Pool;
  let tmp: string;
  let statePath: string;

  beforeAll(async () => {
    storage = PgStorage.create({ connectionString: pgUrl(), migrationsDir: MIGRATIONS_DIR });
    await storage.init();
    pool = storage.pgPool();
  });
  afterAll(async () => { await storage.close(); });

  beforeEach(async () => {
    await pool.query(TRUNCATE_SQL);
    tmp = mkdtempSync(join(tmpdir(), "nlm-pgbackfill-"));
    statePath = join(tmp, "state.json");
  });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it("writes facts for sessions that have none", async () => {
    await storage.sessions.insertSessionForTest(session("s1", "body one", "2026-05-01T00:00:00Z"));
    await storage.sessions.insertSessionForTest(session("s2", "body two", "2026-05-02T00:00:00Z"));
    const classifier = new ScriptedClassifier(new Map([
      ["body one", classifyResult([{ kind: "decision", subject: "Beacon", predicate: "framework", value: "Hono" }])],
      ["body two", classifyResult([{ kind: "decision", subject: "Beacon", predicate: "db", value: "Postgres" }])],
    ]));

    const report = await backfillFacts( { store: storage.sessions, factStore: storage.facts, classifier, statePath }, "team_local");

    expect(report.processed).toBe(2);
    expect(report.factsWritten).toBe(2);
    expect((await storage.facts.findCurrent("team_local", "Beacon", "framework"))?.value).toBe("Hono");
    expect((await storage.facts.findCurrent("team_local", "Beacon", "db"))?.value).toBe("Postgres");
  });

  it("skips sessions that already have facts (reprocess=false) and is resumable", async () => {
    await storage.sessions.insertSessionForTest(session("s1", "body one", "2026-05-01T00:00:00Z"));
    const classifier = new ScriptedClassifier(new Map([
      ["body one", classifyResult([{ kind: "decision", subject: "Beacon", predicate: "framework", value: "Hono" }])],
    ]));

    const r1 = await backfillFacts( { store: storage.sessions, factStore: storage.facts, classifier, statePath }, "team_local");
    expect(r1.processed).toBe(1);

    // Second run: the session now has facts → excluded by the candidate query.
    const r2 = await backfillFacts( { store: storage.sessions, factStore: storage.facts, classifier, statePath }, "team_local");
    expect(r2.total).toBe(0);
    expect(r2.processed).toBe(0);
  });

  it("supersedes a prior fact when reprocess=true yields a new value", async () => {
    await storage.sessions.insertSessionForTest(session("s1", "body v1", "2026-05-01T00:00:00Z"));
    await backfillFacts( {
      store: storage.sessions, factStore: storage.facts, statePath,
      classifier: new ScriptedClassifier(new Map([
        ["body v1", classifyResult([{ kind: "decision", subject: "Beacon", predicate: "framework", value: "Express" }])],
      ])),
    }, "team_local");

    await storage.sessions.insertSessionForTest(session("s2", "body v2", "2026-05-02T00:00:00Z"));
    await backfillFacts( {
      store: storage.sessions, factStore: storage.facts, statePath: join(tmp, "state2.json"),
      classifier: new ScriptedClassifier(new Map([
        ["body v2", classifyResult([{ kind: "decision", subject: "Beacon", predicate: "framework", value: "Hono" }])],
      ])),
    }, "team_local");

    expect((await storage.facts.findCurrent("team_local", "Beacon", "framework"))?.value).toBe("Hono");
  });
});
