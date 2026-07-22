/**
 * Live test for BundledEmbedderClient: real transformers.js model, no mocks.
 * Opt-in via NLM_BUNDLED_EMBED_TEST=1 because the first run downloads the
 * ~140MB ONNX model; CI and normal `npm test` must stay network-free.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BundledEmbedderClient,
  DEFAULT_MODEL_REPO,
} from "../../src/llm/bundled-embedder-client.js";
import type { IngestRecord } from "../../src/core/storage/sqlite-session-store.js";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";

const LIVE = process.env["NLM_BUNDLED_EMBED_TEST"] === "1";
const TIMEOUT = 300_000;
const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");
const MODEL_DIR =
  process.env["NLM_BUNDLED_MODEL_DIR"] ?? join(homedir(), ".nlm", "models");

function l2Norm(v: Float32Array): number {
  let sum = 0;
  for (const x of v) sum += x * x;
  return Math.sqrt(sum);
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot;
}

function makeRecord(overrides: Partial<IngestRecord> & { id: string; label: string; body: string }): IngestRecord {
  const now = new Date().toISOString();
  return {
    runtime: "claude-code",
    runtimeSessionId: overrides.id,
    startedAt: now,
    endedAt: now,
    durationMin: 5,
    summary: "",
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

describe.skipIf(!LIVE)("bundled embedder (live model)", () => {
  const client = new BundledEmbedderClient({ modelDir: MODEL_DIR });

  it(
    "embeds query and document as 768-dim unit vectors reporting the resolved repo",
    async () => {
      const q = await client.embed("database migration script", "query");
      const d = await client.embed(
        "We wrote a script to migrate the database schema to the new tables.",
        "document",
      );
      expect(q.vector.length).toBe(768);
      expect(d.vector.length).toBe(768);
      expect(Math.abs(l2Norm(q.vector) - 1)).toBeLessThan(1e-3);
      expect(Math.abs(l2Norm(d.vector) - 1)).toBeLessThan(1e-3);
      expect(q.model).toBe(DEFAULT_MODEL_REPO);
      expect(d.model).toBe(DEFAULT_MODEL_REPO);
    },
    TIMEOUT,
  );

  it(
    "scores a related document above an unrelated one",
    async () => {
      const query = await client.embed("database migration script", "query");
      const related = await client.embed(
        "Session covered writing and testing a migration script that moves the database schema forward and backfills the new columns.",
        "document",
      );
      const unrelated = await client.embed(
        "A recipe for slow-cooked beef stew: brown the meat, add carrots, potatoes, and simmer for three hours.",
        "document",
      );
      expect(cosine(query.vector, related.vector)).toBeGreaterThan(
        cosine(query.vector, unrelated.vector),
      );
    },
    TIMEOUT,
  );

  describe("fresh-install slice: index and recall with no external embedder", () => {
    let tmp: string;
    let storage: SqliteStorage;

    beforeAll(async () => {
      tmp = mkdtempSync(join(tmpdir(), "nlm-bundled-live-"));
      storage = SqliteStorage.create({
        dbPath: join(tmp, "canonical.sqlite"),
        migrationsDir: MIGRATIONS_DIR,
      });
      await storage.init();
    });

    afterAll(async () => {
      await storage.close();
      rmSync(tmp, { recursive: true, force: true });
    });

    it(
      "returns the ingested session as the top semantic hit",
      async () => {
        await storage.sessions.insertSession( "team_local",
          makeRecord({
            id: "s_bundled_target",
            label: "sqlite-vec KNN tuning",
            body: "Tuned the sqlite-vec KNN index for session recall: adjusted chunk overfetch, verified cosine distances, and benchmarked semantic search latency on the canonical corpus.",
          }),
          client);
        await storage.sessions.insertSession( "team_local",
          makeRecord({
            id: "s_bundled_decoy",
            label: "garden planning",
            body: "Planned the spring vegetable garden: raised beds for tomatoes and peppers, drip irrigation layout, and a compost rotation schedule.",
          }),
          client);

        const { vector } = await client.embed(
          "tuning the sqlite-vec semantic search index",
          "query",
        );
        const results = await storage.sessions.semanticSearch("team_local", vector, 5);
        expect(results.length).toBeGreaterThan(0);
        expect(results[0]?.sessionId).toBe("s_bundled_target");
      },
      TIMEOUT,
    );
  });
});
