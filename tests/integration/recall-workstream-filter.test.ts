/**
 * Integration: optional workstream filter on RecallService.search().
 *
 * Seeds two sessions both keyword-matching "migration". Binds s1 to ws_nlm.
 * Asserts: with workstream:"NLM" → only s1 returned; without → both returned.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecallService } from "../../src/core/recall/recall-service.js";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import { makeWorkstreamId } from "../../src/core/workstream/model.js";
import { resolveRecallScope } from "../../src/core/recall/resolve-scope.js";
import type { WorkstreamStore } from "../../src/ports/workstream-store.js";
import { makeFact } from "../fixtures/facts.js";
import { makeSession } from "../fixtures/sessions.js";
import { FixedEmbedder } from "../fixtures/llm-stubs.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

function buildWorkstreamResolver(wsStore: WorkstreamStore) {
  return async (tenantId: string, selector: string) => (await resolveRecallScope(wsStore, tenantId, selector)).workstreamIds ?? [];
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
    vi.unstubAllEnvs();
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it.each(["legacy selector", "execution options"] as const)("suppresses shared-entity related facts for scoped %s while preserving unscoped enrichment", async (variant) => {
    vi.stubEnv("NLM_HOOK_INJECT_FACTS", "true");
    vi.stubEnv("NLM_HOOK_FACT_MIN_CORROBORATION", "2");
    vi.stubEnv("NLM_HOOK_FACT_MIN_CONFIDENCE", "0.7");
    vi.stubEnv("NLM_HOOK_FACT_LIMIT", "5");
    for (const id of ["ws_scope", "ws_outside"]) {
      await storage.workstreams.create("team_local", { id, label: id, scope: null });
    }
    const inside = makeSession({ id: "inside", label: "migration plan", entities: ["shared-db"] });
    storage.sessions.insertSessionForTest(inside);
    await storage.sessions.setWorkstreamBinding("team_local", inside.id, "ws_scope", "operator", 1);
    await storage.facts.insert("team_local", makeFact({ id: "inside_fact", sourceSessionId: inside.id,
      subject: "shared-db", predicate: "framework", value: "IN SCOPE SQLITE", sourceQuote: "Inside source quote" }));
    for (const id of ["outside_a", "outside_b"]) {
      storage.sessions.insertSessionForTest(makeSession({ id, label: "Other work", entities: ["shared-db"] }));
      await storage.sessions.setWorkstreamBinding("team_local", id, "ws_outside", "operator", 1);
      await storage.facts.insert("team_local", makeFact({ id: `${id}_fact`, sourceSessionId: id,
        subject: "shared-db", predicate: "secret", value: "OUTSIDE WORKSTREAM VALUE", sourceQuote: "OUTSIDE SOURCE QUOTE" }));
    }
    const svc = new RecallService({ store: storage.sessions, factStore: storage.facts, llm: new FixedEmbedder(),
      resolveWorkstreamMembers: buildWorkstreamResolver(storage.workstreams) });
    const query = { query: "migration", withRelatedFacts: true };
    const unscoped = await svc.search("team_local", query);
    expect(unscoped.results.map((r) => r.id)).toEqual([inside.id]);
    expect(unscoped.relatedFacts).toContainEqual({ subject: "shared-db", predicate: "secret",
      value: "OUTSIDE WORKSTREAM VALUE", corroborationCount: 2 });
    const scoped = variant === "legacy selector"
      ? await svc.search("team_local", { ...query, workstream: "ws_scope" })
      : await svc.search("team_local", query, { workstreamIds: ["ws_scope"] });
    expect(scoped.results.map((r) => r.id)).toEqual([inside.id]);
    expect(JSON.stringify(scoped)).not.toContain("OUTSIDE WORKSTREAM VALUE");
    expect(JSON.stringify(scoped)).not.toContain("OUTSIDE SOURCE QUOTE");
    expect(scoped.relatedFacts).toBeUndefined();
  });

  it("fails closed when an explicit selector has no resolver", async () => {
    storage.sessions.insertSessionForTest(makeSession({ id: "private", label: "migration secret" }));
    const svc = new RecallService({ store: storage.sessions, llm: new FixedEmbedder() });
    expect((await svc.search("team_local", { query: "migration", workstream: "unknown" })).results).toEqual([]);
  });

  it("keeps empty execution scope distinct from unspecified scope", async () => {
    storage.sessions.insertSessionForTest(makeSession({ id: "private", label: "migration secret" }));
    const svc = new RecallService({ store: storage.sessions, llm: new FixedEmbedder() });
    expect((await svc.search("team_local", { query: "migration" }, { workstreamIds: [] })).results).toEqual([]);
    expect((await svc.search("team_local", { query: "migration" })).results.map((r) => r.id)).toEqual(["private"]);
  });

  it("resolves duplicate labels only inside the caller tenant and excludes foreign and unknown IDs", async () => {
    for (const tenant of ["team_local", "team_other"]) {
      const id = `ws_${tenant}`;
      await storage.workstreams.create(tenant, { id, label: "Shared project", scope: null });
      storage.sessions.insertSessionForTest(makeSession({ id: `s_${tenant}`, label: "migration", summary: `${tenant} value` }), tenant);
      await storage.sessions.setWorkstreamBinding(tenant, `s_${tenant}`, id, "operator", 1);
    }
    const svc = new RecallService({ store: storage.sessions, llm: new FixedEmbedder(),
      resolveWorkstreamMembers: buildWorkstreamResolver(storage.workstreams) });
    expect((await svc.search("team_other", { query: "migration", workstream: "Shared project" })).results.map((r) => r.id)).toEqual(["s_team_other"]);
    for (const selector of ["ws_team_local", "unknown"]) {
      expect(await resolveRecallScope(storage.workstreams, "team_other", selector)).toEqual({ status: "not_found", workstreamIds: [] });
      expect((await svc.search("team_other", { query: "migration", workstream: selector })).results).toEqual([]);
    }
    await expect(svc.search("team_other", { query: "migration", workstream: "Shared project" }, { workstreamIds: ["ws_team_local"] })).rejects.toThrow("Inconsistent");
  });

  it("fails closed for cyclic and dangling merge chains", async () => {
    const base = { label: "Corrupt", scope: null, normalizedLabel: "corrupt", status: "merged" as const,
      createdAt: "2026-01-01", updatedAt: "2026-01-01", lastSessionAt: null };
    for (const nodes of [
      [{ ...base, id: "a", mergedInto: "b" }, { ...base, id: "b", mergedInto: "a" }],
      [{ ...base, id: "a", mergedInto: "foreign_missing" }],
    ]) {
      const store = { listAll: async () => nodes } as unknown as WorkstreamStore;
      expect(await resolveRecallScope(store, "team_other", "a")).toEqual({ status: "not_found", workstreamIds: [] });
    }
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
    await wsStore.create("team_local", { id: wsId, label: "NLM", scope: null });
    await store.setWorkstreamBinding("team_local", s1.id, wsId, "operator", 1.0);

    const svc = new RecallService({
      store,
      llm: new FixedEmbedder(),
      resolveWorkstreamMembers: buildWorkstreamResolver(wsStore),
    });

    // With workstream filter: only s1
    const filtered = await svc.search("team_local", { query: "migration", workstream: "NLM" });
    expect(filtered.results.map((r) => r.id)).toEqual(["sess_ws1"]);

    // Without filter: both
    const unfiltered = await svc.search("team_local", { query: "migration" });
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
    await wsStore.create("team_local", { id: ancestorId, label: "NLM Alpha", scope: null });
    await wsStore.create("team_local", { id: survivorId, label: "NLM Core", scope: null });

    // Merge ancestor INTO survivor: sets ancestor.mergedInto = survivorId.
    await wsStore.merge("team_local", ancestorId, survivorId);

    // Seed a session keyword-matching "refactor" and bind it to the ANCESTOR only.
    // If merge-chain resolution is absent, searching by survivor would miss this
    // session because it is not bound directly to survivorId.
    const s = makeSession({ id: "sess_chain", label: "NLM refactor session", summary: "refactor work" });
    store.insertSessionForTest(s);
    await store.setWorkstreamBinding("team_local", s.id, ancestorId, "operator", 1.0);

    const svc = new RecallService({
      store,
      llm: new FixedEmbedder(),
      resolveWorkstreamMembers: buildWorkstreamResolver(wsStore),
    });

    // Searching by survivor label must return the ancestor-bound session because
    // the resolver expands to all workstreams whose merge chain ends at survivor.
    const result = await svc.search("team_local", { query: "refactor", workstream: "NLM Core" });
    expect(result.results.map((r) => r.id)).toContain("sess_chain");

    // Searching by survivor id must also resolve through the merge chain.
    const byId = await svc.search("team_local", { query: "refactor", workstream: survivorId });
    expect(byId.results.map((r) => r.id)).toContain("sess_chain");
  });
});
