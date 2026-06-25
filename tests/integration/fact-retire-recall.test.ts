/**
 * End-to-end regression for NLM #326: supersede_fact (the MCP handler) must
 * actually remove a fact from recall. Before the fix it called
 * markSuperseded(id, null) — a no-op — and the "retired" fact kept serving.
 *
 * Chain under test: supersedeFactHandler → SqliteFactStore.retire →
 * FactRecallService.search no longer returns the fact, while
 * includeSuperseded still surfaces it for audit.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import { FactRecallService } from "../../src/core/recall-facts/fact-recall-service.js";
import { supersedeFactHandler } from "../../src/mcp/server.js";
import type { McpDeps } from "../../src/mcp/server.js";
import type { EmbedResult, LLMClient } from "../../src/ports/llm-client.js";
import { makeFact } from "../fixtures/facts.js";
import { makeSession } from "../fixtures/sessions.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

class UnusedEmbedder implements LLMClient {
  async embed(): Promise<EmbedResult> {
    throw new Error("keyword recall must not embed");
  }
  async rewriteForRecall(): Promise<never> {
    throw new Error("not used");
  }
  nameWorkstream(): Promise<string | null> { throw new Error("stub"); }
  async classify(): Promise<never> {
    throw new Error("not used");
  }
}

describe("supersede_fact end-to-end retirement (NLM #326)", () => {
  let tmp: string;
  let storage: SqliteStorage;
  let recall: FactRecallService;
  let origLogEnv: string | undefined;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-retire-recall-"));
    origLogEnv = process.env["NLM_SUPERSEDENCE_LOG"];
    process.env["NLM_SUPERSEDENCE_LOG"] = join(tmp, "supersedence-log.jsonl");
    storage = SqliteStorage.create({
      dbPath: join(tmp, "canonical.sqlite"),
      migrationsDir: MIGRATIONS_DIR,
    });
    await storage.init();
    storage.sessions.insertSessionForTest(makeSession({ id: "sess_parent", label: "Parent" }));
    recall = new FactRecallService({ factStore: storage.facts, llm: new UnusedEmbedder() });
  });

  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
    if (origLogEnv === undefined) delete process.env["NLM_SUPERSEDENCE_LOG"];
    else process.env["NLM_SUPERSEDENCE_LOG"] = origLogEnv;
  });

  it("removes a retired fact from recall but keeps it for includeSuperseded", async () => {
    await storage.facts.insert(
      makeFact({
        id: "fact_bad",
        subject: "acme-app",
        predicate: "owner",
        value: "user",
        confidence: 0.9,
        sourceSessionId: "sess_parent",
      }),
    );

    const before = await recall.search({ subject: "acme-app", mode: "keyword" });
    expect(before.results.map((r) => r.id)).toEqual(["fact_bad"]);

    const deps: McpDeps = {
      recall: {} as McpDeps["recall"],
      store: {} as McpDeps["store"],
      factStore: storage.facts,
    };
    const res = await supersedeFactHandler(deps, { fact_id: "fact_bad", reason: "feedback-loop noise" });
    expect(res.isError).toBeFalsy();

    const after = await recall.search({ subject: "acme-app", mode: "keyword" });
    expect(after.results.map((r) => r.id)).toEqual([]);

    const audit = await recall.search({ subject: "acme-app", mode: "keyword", includeSuperseded: true });
    expect(audit.results.map((r) => r.id)).toEqual(["fact_bad"]);
  });
});
