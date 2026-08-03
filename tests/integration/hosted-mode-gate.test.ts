/**
 * Hosted-mode gate contract (program spec §4.6, M2 plan Wave C3; M6 retired
 * the M6-FILTER class).
 *
 * Under NLM_HOSTED=1, every LOCAL route must still 403 before any handler
 * logic runs — asserted per exact path+method here, per the plan's
 * "contract-tested per path" requirement. Local mode (NLM_HOSTED unset) must
 * be completely unaffected: this file also proves the same paths behave
 * exactly as before when the flag is off.
 *
 * The routes formerly gated M6-FILTER (citation log, query/fact-query logs,
 * hook-memo files) are no longer disposition-gated at all: their underlying
 * JSONL state is now tenant-attributed (core/tenancy/tenant-state-path.ts)
 * and every handler passes the request's resolved tenant into it, so these
 * routes are reachable in hosted mode with a resolvable token, same as any
 * other tenant-scoped route.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RecallService } from "../../src/core/recall/recall-service.js";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import type { SqliteSessionStore } from "../../src/core/storage/sqlite-session-store.js";
import { createApp } from "../../src/http/app.js";
type AppInstance = ReturnType<typeof createApp>;
import { createMcpServer, citeSessionHandler } from "../../src/mcp/server.js";
import { hashTeamToken } from "../../src/core/tenancy/team-auth.js";
import { DEFAULT_TEAM_ID } from "../../src/core/tenancy/default-team.js";
import { FixedEmbedder } from "../fixtures/llm-stubs.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");
const TEST_TOKEN = "hosted-gate-test-token";

function unit(values: number[]): Float32Array {
  const padded = new Float32Array(768);
  values.forEach((v, i) => { padded[i] = v; });
  return padded;
}

// Every path+method the plan names as LOCAL — the exact list
// installHostedModeGate in src/http/app.ts must gate. Kept independent of
// that file's own HOSTED_GATED_ROUTES constant so this test can't pass by
// tautology if a route silently drops out of both places together.
const LOCAL_ROUTES: ReadonlyArray<{ method: string; path: string }> = [
  { method: "GET", path: "/api/dataset" },
  { method: "GET", path: "/api/data/backup" },
  { method: "POST", path: "/api/data/restore" },
  { method: "GET", path: "/api/data/stats" },
  { method: "POST", path: "/api/classifier" },
  { method: "POST", path: "/api/jobs/reprocess" },
  { method: "DELETE", path: "/api/jobs/reprocess" },
];

// Formerly M6-FILTER-gated (403 in hosted mode until citation-log.jsonl /
// query_log.jsonl / fact_query_log.jsonl / hook-state became tenant-
// attributed). Now reachable in every mode with a resolvable token — the
// "un-gated" describe block below drives each with a valid payload and
// asserts a real (non-403) response.
const FORMERLY_M6_FILTER_ROUTES: ReadonlyArray<{ method: string; path: string }> = [
  { method: "POST", path: "/api/recall/cite-event" },
  { method: "POST", path: "/api/citation/explicit" },
  { method: "GET", path: "/api/recall/stats" },
  { method: "GET", path: "/api/recall/recent" },
  { method: "GET", path: "/api/recall/facts/stats" },
  { method: "POST", path: "/api/hook/pre-compact" },
  { method: "POST", path: "/api/hook/hermes-agent/post-turn" },
  { method: "POST", path: "/api/hook/hermes-agent/session-lifecycle" },
];

const ALL_GATED_ROUTES = [...LOCAL_ROUTES, ...FORMERLY_M6_FILTER_ROUTES];

// Valid minimal payload per formerly-gated POST route, so the "un-gated"
// assertions below exercise a real 200 response rather than a validation 400
// that would also mask a lingering 403.
const FORMERLY_M6_FILTER_BODIES: Readonly<Record<string, unknown>> = {
  "/api/recall/cite-event": { conversation_id: "conv-hosted-test", cited_id: "cited-id-1" },
  "/api/citation/explicit": { id: "cited-id-1" },
  "/api/hook/pre-compact": { conversation_id: "conv-hosted-test" },
  "/api/hook/hermes-agent/post-turn": { session_id: "sess-hosted-test" },
  "/api/hook/hermes-agent/session-lifecycle": { event: "start" },
};

async function requestFor(app: AppInstance, route: { method: string; path: string }): Promise<Response> {
  const init: RequestInit = { method: route.method, headers: { authorization: `Bearer ${TEST_TOKEN}` } };
  if (route.method === "POST") {
    init.headers = { ...init.headers, "content-type": "application/json" };
    init.body = JSON.stringify(FORMERLY_M6_FILTER_BODIES[route.path] ?? {});
  }
  return app.request(route.path, init);
}

describe("hosted-mode gate (spec §4.6, Wave C3)", () => {
  let tmp: string;
  let storage: SqliteStorage;
  let store: SqliteSessionStore;
  let app: AppInstance;
  const prevHosted = process.env["NLM_HOSTED"];

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-hosted-gate-"));
    storage = SqliteStorage.create({ dbPath: join(tmp, "canonical.sqlite"), migrationsDir: MIGRATIONS_DIR });
    await storage.init();
    store = storage.sessions;
    // A resolvable team token so requests survive the general /api/* gate
    // (M3: hosted mode has no ungated fallback) and reach the disposition
    // gate under test, exactly as they did before M3 tightened auth.
    await storage.teamTokens.insert(hashTeamToken(TEST_TOKEN), DEFAULT_TEAM_ID);
    // The un-gated former M6-FILTER routes below write real DEFAULT_TEAM_ID
    // file state (citation/query/fact-query logs, hook-state) — redirect via
    // the modules' existing env-var overrides so this run touches tmp, not
    // the developer's real ~/.nlm/*.
    process.env["NLM_QUERY_LOG"] = join(tmp, "query_log.jsonl");
    process.env["NLM_CITATION_LOG"] = join(tmp, "citation-log.jsonl");
    process.env["NLM_FACT_QUERY_LOG"] = join(tmp, "fact_query_log.jsonl");
    process.env["NLM_HOOK_LOG"] = join(tmp, "hook-log.jsonl");
    process.env["NLM_HOOK_STATE_DIR"] = join(tmp, "hook-state");
    const recall = new RecallService({ store, llm: new FixedEmbedder(unit([0, 1, 0])) });
    app = createApp({ recall, store, liveStore: store, dbPath: join(tmp, "canonical.sqlite"), teamTokens: storage.teamTokens });
  });

  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
    if (prevHosted === undefined) delete process.env["NLM_HOSTED"];
    else process.env["NLM_HOSTED"] = prevHosted;
    delete process.env["NLM_QUERY_LOG"];
    delete process.env["NLM_CITATION_LOG"];
    delete process.env["NLM_FACT_QUERY_LOG"];
    delete process.env["NLM_HOOK_LOG"];
    delete process.env["NLM_HOOK_STATE_DIR"];
  });

  describe("NLM_HOSTED=1", () => {
    beforeEach(() => {
      process.env["NLM_HOSTED"] = "1";
    });

    for (const route of LOCAL_ROUTES) {
      it(`${route.method} ${route.path} -> 403, disposition LOCAL`, async () => {
        const res = await requestFor(app, route);
        expect(res.status).toBe(403);
        const body = (await res.json()) as { disposition?: string };
        expect(body.disposition).toBe("LOCAL");
      });
    }

    // Former M6-FILTER routes: un-gated, since citation-log.jsonl /
    // query_log.jsonl / fact_query_log.jsonl / hook-state are now
    // tenant-attributed. A resolvable token reaches the real handler and
    // gets a real (non-403) response driven off a valid payload.
    for (const route of FORMERLY_M6_FILTER_ROUTES) {
      it(`${route.method} ${route.path} -> serves a tenant-scoped response in hosted mode (no longer 403)`, async () => {
        const res = await requestFor(app, route);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { disposition?: string };
        expect(body.disposition).toBeUndefined();
      });
    }

    it("does not gate an unrelated FILTER route (GET /api/recall)", async () => {
      const res = await app.request("/api/recall?q=x&mode=keyword", {
        headers: { authorization: `Bearer ${TEST_TOKEN}` },
      });
      expect(res.status).toBe(200);
    });

    it("does not gate OOS routes (GET /api/health)", async () => {
      // Health is unauthenticated in every mode (no token needed).
      const res = await app.request("/api/health");
      expect(res.status).toBe(200);
    });

    it("cite_session MCP tool works normally in hosted mode (M6-FILTER gate retired — citation-log.jsonl is tenant-attributed)", async () => {
      const result = await citeSessionHandler("team_local", { id: "cc_sub_abc123def456" });
      expect(result.isError).toBeFalsy();
    });

    it("createMcpServer still registers cite_session under NLM_HOSTED", () => {
      const server = createMcpServer({ recall: { search: async () => ({ query: "", mode: "keyword", limit: 0, total: 0, results: [] }) } as never, store }, "team_local");
      expect(server).toBeDefined();
    });

    // M3 (spec §3): hosted mode has no ungated fallback — even a FILTER
    // route (not disposition-gated at all) 401s without a resolvable token.
    it("a FILTER route 401s with no token in hosted mode (no ungated fallback)", async () => {
      const res = await app.request("/api/recall?q=x&mode=keyword");
      expect(res.status).toBe(401);
    });

    it("a FILTER route 401s with a garbage token in hosted mode", async () => {
      const res = await app.request("/api/recall?q=x&mode=keyword", {
        headers: { authorization: "Bearer not-a-real-token" },
      });
      expect(res.status).toBe(401);
    });
  });

  describe("NLM_HOSTED unset (local mode) — zero behavior change", () => {
    beforeEach(() => {
      delete process.env["NLM_HOSTED"];
    });

    for (const route of ALL_GATED_ROUTES) {
      it(`${route.method} ${route.path} is reachable (never a gate-403) in local mode`, async () => {
        const res = await requestFor(app, route);
        expect(res.status).not.toBe(403);
      });
    }

    it("cite_session MCP tool works normally", async () => {
      const result = await citeSessionHandler("team_local", { id: "cc_sub_abc123def456" });
      expect(result.isError).toBeFalsy();
    });
  });
});
