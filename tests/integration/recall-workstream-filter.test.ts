/**
 * Integration: optional workstream filter on RecallService.search().
 *
 * Seeds two sessions both keyword-matching "migration". Binds s1 to ws_nlm.
 * Asserts: with workstream:"NLM" → only s1 returned; without → both returned.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RecallService } from "../../src/core/recall/recall-service.js";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import { makeWorkstreamId } from "../../src/core/workstream/model.js";
import type { EmbedResult, LLMClient } from "../../src/ports/llm-client.js";
import { makeSession } from "../fixtures/sessions.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

class FixedEmbedder implements LLMClient {
  async embed(): Promise<EmbedResult> {
    const v = new Float32Array(768);
    v[0] = 1;
    return { vector: v, model: "fixed-test" };
  }
  async rewriteForRecall(): Promise<never> {
    throw new Error("not used");
  }
  async classify(): Promise<never> {
    throw new Error("not used");
  }
}

describe("RecallService workstream filter (integration)", () => {
  let tmp: string;
  let storage: SqliteStorage;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-ws-recall-"));
    storage = SqliteStorage.create({
      dbPath: join(tmp, "canonical.sqlite"),
      migrationsDir: MIGRATIONS_DIR,
    });
    await storage.init();
  });

  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("filters to the bound workstream; without filter both return", async () => {
    const store = storage.sessions;
    const wsStore = storage.workstreams;

    // Two sessions — both keyword-match "migration"
    const s1 = makeSession({ id: "sess_ws1", label: "NLM migration plan", summary: "migration work" });
    const s2 = makeSession({ id: "sess_ws2", label: "Hono migration setup", summary: "migration work" });
    store.insertSessionForTest(s1);
    store.insertSessionForTest(s2);

    // Bind s1 to workstream "NLM"
    const wsId = makeWorkstreamId();
    await wsStore.create({ id: wsId, label: "NLM" });
    await store.setWorkstreamBinding(s1.id, wsId, "operator", 1.0);

    // resolveWorkstreamSessions: resolve idOrLabel → allowed Set<string>
    const resolveWorkstreamSessions = async (idOrLabel: string): Promise<Set<string>> => {
      const all = await wsStore.listAll();
      const byId = new Map(all.map((w) => [w.id, { id: w.id, mergedInto: w.mergedInto }]));
      const { normalizeLabel, } = await import("../../src/core/workstream/model.js");
      const { resolveWorkstreamId } = await import("../../src/core/workstream/resolve.js");
      const target = all.find((w) => w.id === idOrLabel)
        ?? all.find((w) => normalizeLabel(w.label) === normalizeLabel(idOrLabel));
      if (!target) return new Set();
      const survivor = resolveWorkstreamId(target.id, byId);
      const members = all.filter((w) => resolveWorkstreamId(w.id, byId) === survivor).map((w) => w.id);
      const sessionIds = await store.listSessionIdsByWorkstreams(members);
      return new Set(sessionIds);
    };

    const svc = new RecallService({
      store,
      llm: new FixedEmbedder(),
      resolveWorkstreamSessions,
    });

    // With workstream filter: only s1
    const filtered = await svc.search({ query: "migration", workstream: "NLM" });
    expect(filtered.results.map((r) => r.id)).toEqual(["sess_ws1"]);

    // Without filter: both
    const unfiltered = await svc.search({ query: "migration" });
    const ids = unfiltered.results.map((r) => r.id).sort();
    expect(ids).toContain("sess_ws1");
    expect(ids).toContain("sess_ws2");
  });
});
