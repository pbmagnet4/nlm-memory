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
import { makeWorkstreamId, normalizeLabel } from "../../src/core/workstream/model.js";
import { resolveWorkstreamId } from "../../src/core/workstream/resolve.js";
import type { EmbedResult, LLMClient } from "../../src/ports/llm-client.js";
import type { WorkstreamStore } from "../../src/ports/workstream-store.js";
import type { SessionStore } from "../../src/ports/session-store.js";
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

/**
 * Exact mirror of the resolveWorkstreamSessions closure in buildStack() (src/cli/nlm.ts).
 * Using the real resolveWorkstreamId + normalizeLabel + listAll + listSessionIdsByWorkstreams
 * ensures the test goes through the genuine merge-chain resolution path.
 */
function buildWorkstreamResolver(
  wsStore: WorkstreamStore,
  sessionStore: SessionStore,
): (idOrLabel: string) => Promise<Set<string>> {
  return async (idOrLabel: string) => {
    const all = await wsStore.listAll();
    const byId = new Map(all.map((w) => [w.id, { id: w.id, mergedInto: w.mergedInto }]));
    const target =
      all.find((w) => w.id === idOrLabel) ??
      all.find((w) => normalizeLabel(w.label) === normalizeLabel(idOrLabel));
    if (!target) return new Set();
    const survivor = resolveWorkstreamId(target.id, byId);
    const members = all.filter((w) => resolveWorkstreamId(w.id, byId) === survivor).map((w) => w.id);
    return new Set(await sessionStore.listSessionIdsByWorkstreams(members));
  };
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

    // resolveWorkstreamSessions: exact same closure as buildStack() in nlm.ts
    const resolveWorkstreamSessions = buildWorkstreamResolver(wsStore, store);

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

  it("resolves merge chains: ancestor-bound session appears under survivor label", async () => {
    const store = storage.sessions;
    const wsStore = storage.workstreams;

    // Seed two workstreams: ancestor and survivor.
    const ancestorId = makeWorkstreamId();
    const survivorId = makeWorkstreamId();
    await wsStore.create({ id: ancestorId, label: "NLM Alpha" });
    await wsStore.create({ id: survivorId, label: "NLM Core" });

    // Merge ancestor INTO survivor: sets ancestor.mergedInto = survivorId.
    await wsStore.merge(ancestorId, survivorId);

    // Seed a session keyword-matching "refactor" and bind it to the ANCESTOR only.
    // If merge-chain resolution is absent, searching by survivor would miss this
    // session because it is not bound directly to survivorId.
    const s = makeSession({ id: "sess_chain", label: "NLM refactor session", summary: "refactor work" });
    store.insertSessionForTest(s);
    await store.setWorkstreamBinding(s.id, ancestorId, "operator", 1.0);

    // Wire RecallService with the real buildStack resolver — the same closure
    // used in production (resolveWorkstreamId + normalizeLabel + listAll + listSessionIdsByWorkstreams).
    const svc = new RecallService({
      store,
      llm: new FixedEmbedder(),
      resolveWorkstreamSessions: buildWorkstreamResolver(wsStore, store),
    });

    // Searching by survivor label must return the ancestor-bound session because
    // the resolver expands to all workstreams whose merge chain ends at survivor.
    const result = await svc.search({ query: "refactor", workstream: "NLM Core" });
    expect(result.results.map((r) => r.id)).toContain("sess_chain");

    // Searching by survivor id must also resolve through the merge chain.
    const byId = await svc.search({ query: "refactor", workstream: survivorId });
    expect(byId.results.map((r) => r.id)).toContain("sess_chain");
  });
});
