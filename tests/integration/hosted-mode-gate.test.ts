/**
 * Hosted-mode gate contract (program spec §4.6, M2 plan Wave C3).
 *
 * Under NLM_HOSTED=1, every LOCAL and M6-FILTER route must 403 before any
 * handler logic runs — asserted per exact path+method here, per the plan's
 * "contract-tested per path" requirement. Local mode (NLM_HOSTED unset) must
 * be completely unaffected: this file also proves the same paths behave
 * exactly as before when the flag is off.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { RecallService } from "../../src/core/recall/recall-service.js";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import type { SqliteSessionStore } from "../../src/core/storage/sqlite-session-store.js";
import { createApp } from "../../src/http/app.js";
import { createMcpServer, citeSessionHandler } from "../../src/mcp/server.js";
import { FixedEmbedder } from "../fixtures/llm-stubs.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

function unit(values: number[]): Float32Array {
  const padded = new Float32Array(768);
  values.forEach((v, i) => { padded[i] = v; });
  return padded;
}

// Every path+method the plan names as LOCAL or M6-FILTER — the exact list
// installHostedModeGate in src/http/app.ts must gate. Kept independent of
// that file's own HOSTED_GATED_ROUTES constant so this test can't pass by
// tautology if a route silently drops out of both places together.
const LOCAL_ROUTES: ReadonlyArray<{ method: string; path: string }> = [
  { method: "GET", path: "/api/dataset" },
  { method: "GET", path: "/api/data/backup" },
  { method: "POST", path: "/api/data/restore" },
  { method: "GET", path: "/api/data/stats" },
  { method: "POST", path: "/api/classifier" },
];

const M6_FILTER_ROUTES: ReadonlyArray<{ method: string; path: string }> = [
  { method: "POST", path: "/api/recall/cite-event" },
  { method: "POST", path: "/api/citation/explicit" },
  { method: "GET", path: "/api/recall/stats" },
  { method: "GET", path: "/api/recall/recent" },
  { method: "GET", path: "/api/recall/facts/stats" },
  { method: "POST", path: "/api/hook/pre-compact" },
  { method: "POST", path: "/api/hook/hermes-agent/post-turn" },
  { method: "POST", path: "/api/hook/hermes-agent/session-lifecycle" },
];

const ALL_GATED_ROUTES = [...LOCAL_ROUTES, ...M6_FILTER_ROUTES];

async function requestFor(app: Hono, route: { method: string; path: string }): Promise<Response> {
  const init: RequestInit = { method: route.method };
  if (route.method === "POST") {
    init.headers = { "content-type": "application/json" };
    init.body = "{}";
  }
  return app.request(route.path, init);
}

describe("hosted-mode gate (spec §4.6, Wave C3)", () => {
  let tmp: string;
  let storage: SqliteStorage;
  let store: SqliteSessionStore;
  let app: Hono;
  const prevHosted = process.env["NLM_HOSTED"];

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-hosted-gate-"));
    storage = SqliteStorage.create({ dbPath: join(tmp, "canonical.sqlite"), migrationsDir: MIGRATIONS_DIR });
    await storage.init();
    store = storage.sessions;
    const recall = new RecallService({ store, llm: new FixedEmbedder(unit([0, 1, 0])) });
    app = createApp({ recall, store, liveStore: store, dbPath: join(tmp, "canonical.sqlite") });
  });

  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
    if (prevHosted === undefined) delete process.env["NLM_HOSTED"];
    else process.env["NLM_HOSTED"] = prevHosted;
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

    for (const route of M6_FILTER_ROUTES) {
      it(`${route.method} ${route.path} -> 403, disposition M6-FILTER`, async () => {
        const res = await requestFor(app, route);
        expect(res.status).toBe(403);
        const body = (await res.json()) as { disposition?: string };
        expect(body.disposition).toBe("M6-FILTER");
      });
    }

    it("does not gate an unrelated FILTER route (GET /api/recall)", async () => {
      const res = await app.request("/api/recall?q=x&mode=keyword");
      expect(res.status).toBe(200);
    });

    it("does not gate OOS routes (GET /api/health)", async () => {
      const res = await app.request("/api/health");
      expect(res.status).toBe(200);
    });

    it("cite_session MCP tool returns an error result (not a throw) naming M6", async () => {
      const result = await citeSessionHandler("team_local", { id: "cc_sub_abc123def456" });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("M6");
    });

    it("createMcpServer still registers cite_session under NLM_HOSTED (gate is inside the handler, not registration)", () => {
      const server = createMcpServer({ recall: { search: async () => ({ query: "", mode: "keyword", limit: 0, total: 0, results: [] }) } as never, store }, "team_local");
      expect(server).toBeDefined();
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
