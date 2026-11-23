/**
 * POST /api/voice/sample (T2438 piece C, design §C1).
 *
 * The whole intake contract in one file: the flag decides whether the route
 * exists at all, the store decides whether the deployment can serve it,
 * validation is the only thing standing between a caller and the corpus, and
 * embedding is best-effort — a dead embedder must still leave a stored sample.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/http/app.js";
import { WorkTracker } from "../../src/core/lifecycle/work-tracker.js";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import type { WritingSampleInput, WritingSampleStore } from "../../src/ports/writing-sample-store.js";
import type { EmbeddingKind } from "../../src/ports/llm-client.js";

const INSTALL_SCOPE = "install-endpoint-test";
const SAMPLE = {
  voice: "edward",
  channel: "linkedin",
  text: "Automation is a documentation problem, not a tooling problem.",
  outcome: "published",
  ts: "2026-11-20T09:00:00.000Z",
};

/** Insert-only fake: enough of WritingSampleStore to drive the route. */
function fakeStore(opts: { skipped?: boolean } = {}): WritingSampleStore & {
  inserted: WritingSampleInput[];
  embedded: Array<{ id: string; length: number }>;
} {
  const inserted: WritingSampleInput[] = [];
  const embedded: Array<{ id: string; length: number }> = [];
  return {
    inserted,
    embedded,
    async insert(_tenantId, input) {
      inserted.push(input);
      return { id: `sample-${inserted.length}`, skipped: opts.skipped ?? false };
    },
    async upsertEmbedding(_tenantId, id, vector) {
      embedded.push({ id, length: vector.length });
    },
    async missingEmbeddings() {
      return [];
    },
    async search() {
      return [];
    },
  };
}

function proseEmbedder(fail = false): { embed: (text: string, kind: EmbeddingKind) => Promise<{ vector: Float32Array; model: string }> } {
  return {
    embed: async (text: string, kind: EmbeddingKind) => {
      if (fail) throw new Error("embedder unreachable");
      expect(kind).toBe("document");
      return { vector: new Float32Array(text.length > 0 ? 768 : 1), model: "test-prose" };
    },
  };
}

function appWith(deps: {
  store?: WritingSampleStore;
  prose?: { embed: (text: string, kind: EmbeddingKind) => Promise<{ vector: Float32Array; model: string }> };
  workTracker?: WorkTracker;
}) {
  return createApp({
    recall: { search: async () => ({ query: "", mode: "keyword", limit: 0, total: 0, results: [] }) } as never,
    store: {} as never,
    ...(deps.store ? { writingSampleStore: deps.store } : {}),
    ...(deps.prose ? { embedder: { prose: deps.prose } as never } : {}),
    ...(deps.workTracker ? { workTracker: deps.workTracker } : {}),
  } as never);
}

async function post(app: ReturnType<typeof createApp>, body: unknown) {
  return app.request("/api/voice/sample", {
    method: "POST",
    headers: { "content-type": "application/json", host: "localhost:3940" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function bodyOf(res: Response): Promise<Record<string, unknown>> {
  return await res.json() as Record<string, unknown>;
}

describe("POST /api/voice/sample", () => {
  const prevFlag = process.env["NLM_VOICE_ENABLED"];
  beforeEach(() => {
    delete process.env["NLM_VOICE_ENABLED"];
  });
  afterEach(() => {
    if (prevFlag === undefined) delete process.env["NLM_VOICE_ENABLED"];
    else process.env["NLM_VOICE_ENABLED"] = prevFlag;
  });

  describe("the flag and the wiring gate", () => {
    it("is a 404 when NLM_VOICE_ENABLED is not 1", async () => {
      const app = appWith({ store: fakeStore() });
      expect((await post(app, SAMPLE)).status).toBe(404);

      process.env["NLM_VOICE_ENABLED"] = "0";
      expect((await post(app, SAMPLE)).status).toBe(404);
    });

    it("is a 503 when the flag is on but no store is wired", async () => {
      process.env["NLM_VOICE_ENABLED"] = "1";
      const res = await post(appWith({}), SAMPLE);
      expect(res.status).toBe(503);
      expect((await bodyOf(res)).error).toMatch(/not wired/);
    });

    it("answers 404 rather than 503 with the flag off, so an unwired install leaks nothing", async () => {
      expect((await post(appWith({}), SAMPLE)).status).toBe(404);
    });
  });

  describe("validation", () => {
    beforeEach(() => {
      process.env["NLM_VOICE_ENABLED"] = "1";
    });

    it("stores a well-formed sample and reports the new id", async () => {
      const store = fakeStore();
      const res = await post(appWith({ store }), {
        ...SAMPLE,
        audience: "client-blog",
        source: "onboarding",
        source_ref: "https://whtnxt.com/one-job",
        context: "Reply to Dana's question about tooling",
        draft_id: "draft-1",
        session_id: "session-1",
      });

      expect(res.status).toBe(201);
      expect(await bodyOf(res)).toEqual({ id: "sample-1", skipped: false });
      expect(store.inserted[0]).toEqual({
        voice: "edward",
        channel: "linkedin",
        audience: "client-blog",
        source: "onboarding",
        sourceRef: "https://whtnxt.com/one-job",
        text: SAMPLE.text,
        context: "Reply to Dana's question about tooling",
        outcome: "published",
        draftId: "draft-1",
        sessionId: "session-1",
        ts: SAMPLE.ts,
      });
    });

    it("rejects a body that is not JSON", async () => {
      const res = await post(appWith({ store: fakeStore() }), "{not json");
      expect(res.status).toBe(400);
      expect((await bodyOf(res)).error).toMatch(/JSON/);
    });

    it("rejects text that is empty or whitespace only", async () => {
      const store = fakeStore();
      const app = appWith({ store });
      expect((await post(app, { ...SAMPLE, text: "" })).status).toBe(400);
      expect((await post(app, { ...SAMPLE, text: "   \n\t " })).status).toBe(400);
      expect(store.inserted).toHaveLength(0);
    });

    it("rejects text over 20,000 characters and accepts the limit itself", async () => {
      const app = appWith({ store: fakeStore() });
      expect((await post(app, { ...SAMPLE, text: "a".repeat(20_001) })).status).toBe(400);
      expect((await post(app, { ...SAMPLE, text: "a".repeat(20_000) })).status).toBe(201);
    });

    it("rejects an unknown outcome or source, and a missing voice or channel", async () => {
      const store = fakeStore();
      const app = appWith({ store });
      expect((await post(app, { ...SAMPLE, outcome: "shipped" })).status).toBe(400);
      expect((await post(app, { ...SAMPLE, source: "newsletter" })).status).toBe(400);
      expect((await post(app, { ...SAMPLE, voice: "  " })).status).toBe(400);
      expect((await post(app, { channel: SAMPLE.channel, text: SAMPLE.text, outcome: "published" })).status).toBe(400);
      expect((await post(app, { ...SAMPLE, ts: "the day before yesterday" })).status).toBe(400);
      expect(store.inserted).toHaveLength(0);
    });

    it("names the offending field so a producer can fix its call", async () => {
      const res = await post(appWith({ store: fakeStore() }), { ...SAMPLE, outcome: "shipped" });
      expect((await bodyOf(res)).error).toMatch(/outcome/);
    });
  });

  describe("dedup", () => {
    beforeEach(() => {
      process.env["NLM_VOICE_ENABLED"] = "1";
    });

    it("answers 200 with skipped: true when the store already has the row", async () => {
      const res = await post(appWith({ store: fakeStore({ skipped: true }) }), SAMPLE);
      expect(res.status).toBe(200);
      expect(await bodyOf(res)).toEqual({ id: "sample-1", skipped: true });
    });

    it("does not spend an embed call re-embedding a duplicate", async () => {
      const store = fakeStore({ skipped: true });
      const tracker = new WorkTracker();
      const app = appWith({ store, prose: proseEmbedder(), workTracker: tracker });

      expect((await post(app, SAMPLE)).status).toBe(200);
      await tracker.drain();
      expect(store.embedded).toEqual([]);
    });
  });

  describe("source defaults from outcome", () => {
    beforeEach(() => {
      process.env["NLM_VOICE_ENABLED"] = "1";
    });

    it.each([
      ["published", "published"],
      ["approved", "approved"],
      ["rejected", "approved"],
      ["pending_review", "approved"],
    ] as const)("maps outcome %s to source %s", async (outcome, expected) => {
      const store = fakeStore();
      expect((await post(appWith({ store }), { ...SAMPLE, outcome })).status).toBe(201);
      expect(store.inserted[0]!.source).toBe(expected);
    });

    it("keeps an explicit source, which is how the email import lands as import", async () => {
      const store = fakeStore();
      await post(appWith({ store }), { ...SAMPLE, source: "import", outcome: "approved" });
      expect(store.inserted[0]!.source).toBe("import");
    });
  });

  describe("best-effort embedding", () => {
    beforeEach(() => {
      process.env["NLM_VOICE_ENABLED"] = "1";
    });

    it("embeds the stored text on the prose lane and upserts the vector", async () => {
      const store = fakeStore();
      const tracker = new WorkTracker();
      const app = appWith({ store, prose: proseEmbedder(), workTracker: tracker });

      expect((await post(app, SAMPLE)).status).toBe(201);
      await tracker.drain();
      expect(store.embedded).toEqual([{ id: "sample-1", length: 768 }]);
    });

    it("still returns 201 when the embedder fails, leaving the row for the sweep", async () => {
      const store = fakeStore();
      const tracker = new WorkTracker();
      const app = appWith({ store, prose: proseEmbedder(true), workTracker: tracker });

      expect((await post(app, SAMPLE)).status).toBe(201);
      await tracker.drain();
      expect(store.inserted).toHaveLength(1);
      expect(store.embedded).toEqual([]);
    });

    it("stores the sample when no prose embedder is wired at all", async () => {
      const store = fakeStore();
      expect((await post(appWith({ store }), SAMPLE)).status).toBe(201);
      expect(store.embedded).toEqual([]);
    });
  });

  describe("against the real store", () => {
    let storage: SqliteStorage;
    let dir: string;

    beforeEach(async () => {
      process.env["NLM_VOICE_ENABLED"] = "1";
      dir = mkdtempSync(join(tmpdir(), "nlm-voice-endpoint-"));
      storage = SqliteStorage.create({
        dbPath: join(dir, "corpus.sqlite"),
        migrationsDir: resolve("migrations"),
        installScopeProvider: () => INSTALL_SCOPE,
      });
    });

    afterEach(async () => {
      await storage.close();
      rmSync(dir, { recursive: true, force: true });
    });

    it("stamps the server-side scope, and re-posting the same text dedupes to 200", async () => {
      const app = appWith({ store: storage.writingSamples });

      const first = await post(app, SAMPLE);
      expect(first.status).toBe(201);
      const { id } = await bodyOf(first);

      const repost = await post(app, { ...SAMPLE, text: `  ${SAMPLE.text}\n\n`, source: "published" });
      expect(repost.status).toBe(200);
      expect((await bodyOf(repost)).id).toBe(id);

      const row = storage.rawDb()
        .prepare<[string], { install_scope: string; tenant_id: string }>("SELECT install_scope, tenant_id FROM writing_samples WHERE id = ?")
        .get(id as string);
      expect(row).toEqual({ install_scope: INSTALL_SCOPE, tenant_id: "team_local" });
    });

    it("leaves an unembedded row to the sweep when no embedder is wired", async () => {
      const tracker = new WorkTracker();
      const app = appWith({ store: storage.writingSamples, workTracker: tracker });

      const { id } = await bodyOf(await post(app, SAMPLE));
      await tracker.drain();

      expect(await storage.writingSamples.missingEmbeddings("team_local", 8)).toEqual([{ id, text: SAMPLE.text }]);
    });
  });
});
