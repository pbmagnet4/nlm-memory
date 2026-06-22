/**
 * Fact-recall regression gate. A small SYNTHETIC fact corpus + topic queries,
 * run through the real FactRecallService against a real SqliteFactStore in
 * keyword mode (no embedder reachable). Asserts R@5 stays at or above a
 * conservative floor so a real regression fails CI but noise does not. Mirrors
 * tests/integration/recall-golden.test.ts for the session lane.
 *
 * No client/home/infra data: the corpus is invented and committed.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import { FactRecallService } from "../../src/core/recall-facts/fact-recall-service.js";
import { runEval } from "../../src/core/eval/run-eval.js";
import type { EvalQuery } from "../../src/core/eval/run-eval.js";
import type { EmbedResult, LLMClient } from "../../src/ports/llm-client.js";
import { LLMUnreachableError } from "../../src/ports/llm-client.js";
import { makeFact } from "../fixtures/facts.js";
import { makeSession } from "../fixtures/sessions.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

// Keyword-only fact recall must never touch the embedder.
class UnreachableEmbedder implements LLMClient {
  async embed(): Promise<EmbedResult> {
    throw new LLMUnreachableError("ollama");
  }
  async rewriteForRecall(): Promise<never> {
    throw new Error("not used in tests");
  }
  async classify(): Promise<never> {
    throw new Error("not used");
  }
}

interface SeedFact {
  id: string;
  subject: string;
  predicate: string;
  value: string;
}

const SYNTHETIC_FACTS: ReadonlyArray<SeedFact> = [
  { id: "f_db", subject: "widget-app", predicate: "database", value: "Postgres for the primary store" },
  { id: "f_cache", subject: "widget-app", predicate: "cache layer", value: "Redis for hot reads" },
  { id: "f_queue", subject: "widget-app", predicate: "job queue", value: "BullMQ for background jobs" },
  { id: "f_auth", subject: "widget-app", predicate: "authentication", value: "OAuth via the identity provider" },
  { id: "f_deploy", subject: "widget-app", predicate: "deployment target", value: "Containers on the cluster" },
  { id: "f_lang", subject: "widget-app", predicate: "language", value: "TypeScript across the stack" },
];

// Topic query -> the one fact whose (subject, predicate) it frames. The value
// (the answer) is held out, so each query has exactly one correct fact.
const GATE_QUERIES: ReadonlyArray<EvalQuery> = SYNTHETIC_FACTS.map((f) => ({
  query: `${f.subject} ${f.predicate}`,
  expectedIds: [f.id],
}));

const R5_FLOOR = 0.8;

describe("fact-recall regression gate", () => {
  let tmp: string;
  let storage: SqliteStorage;
  let recall: FactRecallService;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-fact-gate-"));
    storage = SqliteStorage.create({
      dbPath: join(tmp, "canonical.sqlite"),
      migrationsDir: MIGRATIONS_DIR,
    });
    await storage.init();
    storage.sessions.insertSessionForTest(makeSession({ id: "sess_gate", label: "Gate" }));
    for (const f of SYNTHETIC_FACTS) {
      await storage.facts.insert(
        makeFact({
          id: f.id,
          subject: f.subject,
          predicate: f.predicate,
          value: f.value,
          confidence: 0.9,
          sourceSessionId: "sess_gate",
        }),
      );
    }
    recall = new FactRecallService({ factStore: storage.facts, llm: new UnreachableEmbedder() });
  });

  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it(`keeps keyword fact recall R@5 at or above ${R5_FLOOR}`, async () => {
    const report = await runEval({ recall }, GATE_QUERIES, { mode: "keyword", k: 5 });
    expect(report.n).toBe(GATE_QUERIES.length);
    expect(report.rAt5).toBeGreaterThanOrEqual(R5_FLOOR);
  });
});
