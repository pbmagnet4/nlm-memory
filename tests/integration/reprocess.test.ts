/**
 * Integration tests for `nlm reprocess`.
 *
 * Covers: selection correctness (NULL / different-model / low-confidence /
 * current-model), full replacement (label, summary, markers, entities,
 * provenance, embeddings, facts), workstream binding untouched, dry-run
 * produces cohort without writes, resume skips done ids.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import type { SqliteSessionStore, IngestRecord } from "../../src/core/storage/sqlite-session-store.js";
import type { SqliteFactStore } from "../../src/core/storage/sqlite-fact-store.js";
import type { ClassifyResult, EmbedResult, LLMClient } from "../../src/ports/llm-client.js";
import { reprocess, selectReprocessCandidates } from "../../src/core/ingest/reprocess.js";

const MIGRATIONS = resolve(process.cwd(), "migrations");

function fakeClassifier(result: ClassifyResult): LLMClient {
  return {
    classify: async () => result,
    embed: async (): Promise<EmbedResult> => ({ vector: new Float32Array(768), model: "test" }),
    rewriteForRecall: async () => { throw new Error("stub"); },
    nameWorkstream: async () => { throw new Error("stub"); },
  } as LLMClient;
}

function fakeEmbedder(): LLMClient {
  return {
    classify: async () => { throw new Error("stub"); },
    embed: async (): Promise<EmbedResult> => ({ vector: new Float32Array(768), model: "test" }),
    rewriteForRecall: async () => { throw new Error("stub"); },
    nameWorkstream: async () => { throw new Error("stub"); },
  } as LLMClient;
}

function baseRecord(over: Partial<IngestRecord> & { id: string }): IngestRecord {
  return {
    runtime: "claude-code",
    runtimeSessionId: over.id,
    startedAt: "2026-01-01T10:00:00Z",
    endedAt: "2026-01-01T10:30:00Z",
    durationMin: 30,
    label: "Old label",
    summary: "Old summary",
    body: "Session body text for classification",
    status: "closed",
    transcriptKind: "claude-code-jsonl",
    transcriptPath: null,
    transcriptOffset: null,
    transcriptLength: null,
    entities: [],
    decisions: [],
    openQuestions: [],
    ...over,
  };
}

describe("reprocess", () => {
  let tmp: string;
  let stateTmp: string;
  let storage: SqliteStorage;
  let store: SqliteSessionStore;
  let factStore: SqliteFactStore;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-reprocess-"));
    stateTmp = mkdtempSync(join(tmpdir(), "nlm-reprocess-state-"));
    storage = SqliteStorage.create({
      dbPath: join(tmp, "test.sqlite"),
      migrationsDir: MIGRATIONS,
    });
    await storage.init();
    store = storage.sessions;
    factStore = storage.facts;
  });

  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
    rmSync(stateTmp, { recursive: true, force: true });
  });

  describe("selectReprocessCandidates", () => {
    it("selects sessions with NULL classifier_model", async () => {
      await store.insertSession(baseRecord({ id: "sess_null", startedAt: "2026-01-01T10:00:00Z" }));
      const db = store.rawDb();
      const rows = selectReprocessCandidates(db, "current-model");
      expect(rows.map((r) => r.id)).toContain("sess_null");
    });

    it("selects sessions classified by a different model", async () => {
      await store.insertSession(
        baseRecord({
          id: "sess_old",
          startedAt: "2026-01-01T11:00:00Z",
          classifier: { provider: "ollama", model: "old-model", confidence: 0.9 },
        }),
      );
      const db = store.rawDb();
      const rows = selectReprocessCandidates(db, "current-model");
      expect(rows.map((r) => r.id)).toContain("sess_old");
    });

    it("does NOT select sessions already on the current model (no minConfidence)", async () => {
      await store.insertSession(
        baseRecord({
          id: "sess_current",
          startedAt: "2026-01-01T12:00:00Z",
          classifier: { provider: "ollama", model: "current-model", confidence: 0.9 },
        }),
      );
      const db = store.rawDb();
      const rows = selectReprocessCandidates(db, "current-model");
      expect(rows.map((r) => r.id)).not.toContain("sess_current");
    });

    it("selects same-model low-confidence sessions when minConfidence is given", async () => {
      await store.insertSession(
        baseRecord({
          id: "sess_low",
          startedAt: "2026-01-01T13:00:00Z",
          classifier: { provider: "ollama", model: "current-model", confidence: 0.5 },
        }),
      );
      const db = store.rawDb();
      const withMin = selectReprocessCandidates(db, "current-model", 0.7);
      expect(withMin.map((r) => r.id)).toContain("sess_low");
      const withoutMin = selectReprocessCandidates(db, "current-model");
      expect(withoutMin.map((r) => r.id)).not.toContain("sess_low");
    });

    it("does NOT select same-model adequate-confidence when minConfidence is given", async () => {
      await store.insertSession(
        baseRecord({
          id: "sess_adequate",
          startedAt: "2026-01-01T14:00:00Z",
          classifier: { provider: "ollama", model: "current-model", confidence: 0.9 },
        }),
      );
      const db = store.rawDb();
      const rows = selectReprocessCandidates(db, "current-model", 0.7);
      expect(rows.map((r) => r.id)).not.toContain("sess_adequate");
    });

    it("excludes sessions with NULL or empty body", async () => {
      const db = store.rawDb();
      db.prepare(
        "INSERT INTO sessions (id, runtime, runtime_session_id, started_at, label, summary, status, body) " +
        "VALUES ('no_body', 'claude-code', 'no_body', '2026-01-01T15:00:00Z', 'L', 'S', 'closed', NULL)",
      ).run();
      db.prepare(
        "INSERT INTO sessions (id, runtime, runtime_session_id, started_at, label, summary, status, body) " +
        "VALUES ('empty_body', 'claude-code', 'empty_body', '2026-01-01T16:00:00Z', 'L', 'S', 'closed', '')",
      ).run();
      const rows = selectReprocessCandidates(db, "current-model");
      const ids = rows.map((r) => r.id);
      expect(ids).not.toContain("no_body");
      expect(ids).not.toContain("empty_body");
    });

    it("returns candidates in started_at DESC order", async () => {
      await store.insertSession(
        baseRecord({ id: "sess_a", startedAt: "2026-01-01T10:00:00Z" }),
      );
      await store.insertSession(
        baseRecord({ id: "sess_b", startedAt: "2026-01-03T10:00:00Z" }),
      );
      await store.insertSession(
        baseRecord({ id: "sess_c", startedAt: "2026-01-02T10:00:00Z" }),
      );
      const db = store.rawDb();
      const rows = selectReprocessCandidates(db, "current-model");
      const ids = rows.map((r) => r.id);
      expect(ids.indexOf("sess_b")).toBeLessThan(ids.indexOf("sess_c"));
      expect(ids.indexOf("sess_c")).toBeLessThan(ids.indexOf("sess_a"));
    });

    it("does not include a body column in returned rows", async () => {
      await store.insertSession(
        baseRecord({ id: "sess_shape", startedAt: "2026-01-01T10:00:00Z" }),
      );
      const db = store.rawDb();
      const rows = selectReprocessCandidates(db, "current-model");
      const row = rows.find((r) => r.id === "sess_shape");
      expect(row).toBeDefined();
      expect(row).not.toHaveProperty("body");
    });
  });

  describe("reprocess full replacement", () => {
    it("replaces label, summary, entities, decisions, provenance and refreshes embeddings", async () => {
      await store.insertSession(
        baseRecord({
          id: "sess_replace",
          startedAt: "2026-01-01T10:00:00Z",
          label: "Old label",
          summary: "Old summary",
          entities: ["OldEntity"],
          decisions: ["Old decision"],
          openQuestions: ["Old question"],
        }),
      );

      const db = store.rawDb();

      const newClassification: ClassifyResult = {
        label: "New label",
        summary: "New summary",
        entities: ["NewEntity"],
        decisions: ["New decision"],
        open: ["New question"],
        confidence: 0.9,
        facts: [
          {
            kind: "attribute",
            subject: "user",
            predicate: "prefers",
            value: "dark mode",
          },
        ],
      };

      await reprocess(
        {
          db,
          store,
          factStore,
          embedder: fakeEmbedder(),
          classifier: fakeClassifier(newClassification),
          classifierDescriptor: { provider: "deepseek", model: "current-model" },
        },
        { statePath: join(stateTmp, "reprocess.state") },
      );

      const sess = await store.getById("sess_replace");
      expect(sess?.label).toBe("New label");
      expect(sess?.summary).toBe("New summary");
      expect(sess?.entities).toContain("NewEntity");
      expect(sess?.entities).not.toContain("OldEntity");
      expect(sess?.decisions).toContain("New decision");
      expect(sess?.decisions).not.toContain("Old decision");
      expect(sess?.classifierProvider).toBe("deepseek");
      expect(sess?.classifierModel).toBe("current-model");
      expect(sess?.classifierConfidence).toBeCloseTo(0.9);

      const chunkRows = db
        .prepare<[string], { chunk_id: number }>(
          "SELECT chunk_id FROM session_chunk_map WHERE session_id = ?",
        )
        .all("sess_replace");
      expect(chunkRows.length).toBeGreaterThan(0);
    });

    it("leaves workstream binding (workstream_id, binding_source, binding_confidence) untouched", async () => {
      await store.insertSession(baseRecord({ id: "sess_ws", startedAt: "2026-01-01T10:00:00Z" }));

      const db = store.rawDb();
      db.prepare(
        "INSERT INTO workstreams (id, label, status, created_at) VALUES ('ws_1', 'TestWS', 'active', datetime('now'))",
      ).run();
      db.prepare(
        "UPDATE sessions SET workstream_id = 'ws_1', binding_source = 'auto', binding_confidence = 0.77 WHERE id = 'sess_ws'",
      ).run();

      const newClassification: ClassifyResult = {
        label: "New label",
        summary: "New summary",
        entities: [],
        decisions: [],
        open: [],
        confidence: 0.8,
        facts: [],
      };

      await reprocess(
        {
          db,
          store,
          factStore,
          embedder: fakeEmbedder(),
          classifier: fakeClassifier(newClassification),
          classifierDescriptor: { provider: "deepseek", model: "current-model" },
        },
        { statePath: join(stateTmp, "reprocess.state") },
      );

      const row = db
        .prepare<[string], { workstream_id: string | null; binding_source: string | null; binding_confidence: number | null }>(
          "SELECT workstream_id, binding_source, binding_confidence FROM sessions WHERE id = ?",
        )
        .get("sess_ws");
      expect(row?.workstream_id).toBe("ws_1");
      expect(row?.binding_source).toBe("auto");
      expect(row?.binding_confidence).toBeCloseTo(0.77);
    });

    it("replaces entity links: old entities removed, new entities added", async () => {
      await store.insertSession(
        baseRecord({
          id: "sess_entities",
          startedAt: "2026-01-01T10:00:00Z",
          entities: ["Alpha", "Beta"],
        }),
      );

      const db = store.rawDb();

      const links = () =>
        db
          .prepare<[string], { entity_canonical: string }>(
            "SELECT entity_canonical FROM session_entities WHERE session_id = ? ORDER BY entity_canonical",
          )
          .all("sess_entities")
          .map((r) => r.entity_canonical);

      expect(links()).toEqual(["Alpha", "Beta"]);

      const newClassification: ClassifyResult = {
        label: "Updated",
        summary: "Updated",
        entities: ["Beta", "Gamma"],
        decisions: [],
        open: [],
        confidence: 0.85,
        facts: [],
      };

      await reprocess(
        {
          db,
          store,
          factStore,
          embedder: fakeEmbedder(),
          classifier: fakeClassifier(newClassification),
          classifierDescriptor: { provider: "ollama", model: "current-model" },
        },
        { statePath: join(stateTmp, "reprocess.state") },
      );

      expect(links()).toEqual(["Beta", "Gamma"]);
    });

    it("counts belowFloorOverwrites and updates session row but preserves prior facts", async () => {
      await store.insertSession(
        baseRecord({ id: "sess_low_conf", startedAt: "2026-01-01T10:00:00Z", label: "Original label" }),
      );

      const db = store.rawDb();
      db.prepare(
        "INSERT INTO facts (id, kind, subject, predicate, value, source_session_id, created_at, confidence) " +
        "VALUES ('fact_seed', 'attribute', 'user', 'theme', 'dark', 'sess_low_conf', '2026-01-01T10:00:00Z', 0.9)",
      ).run();

      const lowConf: ClassifyResult = {
        label: "Low confidence",
        summary: "Low",
        entities: [],
        decisions: [],
        open: [],
        confidence: 0.2,
        facts: [{ kind: "attribute", subject: "user", predicate: "theme", value: "light" }],
      };

      const report = await reprocess(
        {
          db,
          store,
          factStore,
          embedder: fakeEmbedder(),
          classifier: fakeClassifier(lowConf),
          classifierDescriptor: { provider: "ollama", model: "current-model" },
        },
        { statePath: join(stateTmp, "reprocess.state") },
      );

      expect(report.belowFloorOverwrites).toBe(1);
      expect(report.succeeded).toBe(1);

      const sess = await store.getById("sess_low_conf");
      expect(sess?.label).toBe("Low confidence");
      expect(sess?.classifierConfidence).toBeCloseTo(0.2);

      const facts = await factStore.listBySession("sess_low_conf");
      expect(facts.length).toBe(1);
      expect(facts[0]?.value).toBe("dark");
    });
  });

  describe("dry-run", () => {
    it("returns cohort report without writing anything", async () => {
      await store.insertSession(
        baseRecord({
          id: "sess_dry_1",
          startedAt: "2026-01-01T10:00:00Z",
          classifier: { provider: "ollama", model: "old-model", confidence: 0.7 },
        }),
      );
      await store.insertSession(
        baseRecord({
          id: "sess_dry_2",
          startedAt: "2026-01-02T10:00:00Z",
        }),
      );

      const db = store.rawDb();

      const report = await reprocess(
        {
          db,
          store,
          factStore,
          embedder: fakeEmbedder(),
          classifier: fakeClassifier({
            label: "L",
            summary: "S",
            entities: [],
            decisions: [],
            open: [],
            confidence: 0.9,
            facts: [],
          }),
          classifierDescriptor: { provider: "deepseek", model: "current-model" },
        },
        {
          dryRun: true,
          statePath: join(stateTmp, "reprocess.state"),
        },
      );

      expect(report.totalEligible).toBe(2);
      expect(report.succeeded).toBe(0);
      expect(report.cohort).toBeDefined();
      expect(report.cohort!.length).toBeGreaterThan(0);
      const totalFromCohort = report.cohort!.reduce((acc, g) => acc + g.count, 0);
      expect(totalFromCohort).toBe(2);

      const labelAfter = (await store.getById("sess_dry_1"))?.label;
      expect(labelAfter).toBe("Old label");
    });
  });

  describe("resume", () => {
    it("skips sessions whose ids are in the state file", async () => {
      await store.insertSession(
        baseRecord({ id: "sess_done", startedAt: "2026-01-01T10:00:00Z" }),
      );
      await store.insertSession(
        baseRecord({ id: "sess_todo", startedAt: "2026-01-02T10:00:00Z" }),
      );

      const statePath = join(stateTmp, "reprocess.state");
      const lane = { provider: "deepseek", model: "current-model" };
      writeFileSync(
        statePath,
        JSON.stringify({ done: ["sess_done"], lane }),
      );

      const db = store.rawDb();
      const newClassification: ClassifyResult = {
        label: "Updated",
        summary: "Updated",
        entities: [],
        decisions: [],
        open: [],
        confidence: 0.9,
        facts: [],
      };

      const report = await reprocess(
        {
          db,
          store,
          factStore,
          embedder: fakeEmbedder(),
          classifier: fakeClassifier(newClassification),
          classifierDescriptor: { provider: "deepseek", model: "current-model" },
        },
        { statePath },
      );

      expect(report.skippedAlreadyDone).toBe(1);
      expect(report.succeeded).toBe(1);

      const doneSess = await store.getById("sess_done");
      expect(doneSess?.label).toBe("Old label");

      const todoSess = await store.getById("sess_todo");
      expect(todoSess?.label).toBe("Updated");
    });

    it("invalidates done-set when lane changes", async () => {
      await store.insertSession(
        baseRecord({ id: "sess_stale", startedAt: "2026-01-01T10:00:00Z" }),
      );

      const statePath = join(stateTmp, "reprocess.state");
      writeFileSync(
        statePath,
        JSON.stringify({
          done: ["sess_stale"],
          lane: { provider: "ollama", model: "old-model" },
        }),
      );

      const db = store.rawDb();
      const newClassification: ClassifyResult = {
        label: "Fresh",
        summary: "Fresh",
        entities: [],
        decisions: [],
        open: [],
        confidence: 0.85,
        facts: [],
      };

      const report = await reprocess(
        {
          db,
          store,
          factStore,
          embedder: fakeEmbedder(),
          classifier: fakeClassifier(newClassification),
          classifierDescriptor: { provider: "deepseek", model: "new-model" },
        },
        { statePath },
      );

      expect(report.skippedAlreadyDone).toBe(0);
      expect(report.succeeded).toBe(1);

      const sess = await store.getById("sess_stale");
      expect(sess?.label).toBe("Fresh");
    });
  });

  describe("report fields", () => {
    it("computes mean confidence old and new", async () => {
      await store.insertSession(
        baseRecord({
          id: "sess_conf_a",
          startedAt: "2026-01-01T10:00:00Z",
          classifier: { provider: "ollama", model: "old-model", confidence: 0.6 },
        }),
      );
      await store.insertSession(
        baseRecord({
          id: "sess_conf_b",
          startedAt: "2026-01-02T10:00:00Z",
          classifier: { provider: "ollama", model: "old-model", confidence: 0.8 },
        }),
      );

      const db = store.rawDb();

      let callCount = 0;
      const confs = [0.85, 0.75];
      const sequentialClassifier: LLMClient = {
        classify: async () => {
          const conf = confs[callCount++ % confs.length]!;
          return {
            label: "L",
            summary: "S",
            entities: [],
            decisions: [],
            open: [],
            confidence: conf,
            facts: [],
          };
        },
        embed: async (): Promise<EmbedResult> => ({ vector: new Float32Array(768), model: "test" }),
        rewriteForRecall: async () => { throw new Error("stub"); },
        nameWorkstream: async () => { throw new Error("stub"); },
      } as LLMClient;

      const report = await reprocess(
        {
          db,
          store,
          factStore,
          embedder: fakeEmbedder(),
          classifier: sequentialClassifier,
          classifierDescriptor: { provider: "deepseek", model: "current-model" },
        },
        { statePath: join(stateTmp, "reprocess.state") },
      );

      expect(report.meanConfidenceOld).toBeCloseTo(0.7);
      expect(report.meanConfidenceNew).toBeCloseTo(0.8);
    });

    it("classify failure increments failed and continues", async () => {
      await store.insertSession(
        baseRecord({ id: "sess_fail", startedAt: "2026-01-01T10:00:00Z" }),
      );
      await store.insertSession(
        baseRecord({ id: "sess_ok", startedAt: "2026-01-02T10:00:00Z" }),
      );

      const db = store.rawDb();
      let first = true;
      const flakyClassifier: LLMClient = {
        classify: async () => {
          if (first) {
            first = false;
            throw new Error("model unavailable");
          }
          return {
            label: "OK",
            summary: "OK",
            entities: [],
            decisions: [],
            open: [],
            confidence: 0.9,
            facts: [],
          };
        },
        embed: async (): Promise<EmbedResult> => ({ vector: new Float32Array(768), model: "test" }),
        rewriteForRecall: async () => { throw new Error("stub"); },
        nameWorkstream: async () => { throw new Error("stub"); },
      } as LLMClient;

      const report = await reprocess(
        {
          db,
          store,
          factStore,
          embedder: fakeEmbedder(),
          classifier: flakyClassifier,
          classifierDescriptor: { provider: "deepseek", model: "current-model" },
        },
        { statePath: join(stateTmp, "reprocess.state") },
      );

      expect(report.failed).toBe(1);
      expect(report.succeeded).toBe(1);
    });

    it("separates skippedAlreadyDone (state-file) from limitSkipped (--limit cutoff)", async () => {
      await store.insertSession(baseRecord({ id: "sess_r1", startedAt: "2026-01-01T10:00:00Z" }));
      await store.insertSession(baseRecord({ id: "sess_r2", startedAt: "2026-01-02T10:00:00Z" }));
      await store.insertSession(baseRecord({ id: "sess_r3", startedAt: "2026-01-03T10:00:00Z" }));

      const statePath = join(stateTmp, "reprocess.state");
      const lane = { provider: "deepseek", model: "current-model" };
      writeFileSync(statePath, JSON.stringify({ done: ["sess_r1"], lane }));

      const db = store.rawDb();
      const report = await reprocess(
        {
          db,
          store,
          factStore,
          embedder: fakeEmbedder(),
          classifier: fakeClassifier({
            label: "L",
            summary: "S",
            entities: [],
            decisions: [],
            open: [],
            confidence: 0.9,
            facts: [],
          }),
          classifierDescriptor: { provider: "deepseek", model: "current-model" },
        },
        { statePath, limit: 1 },
      );

      expect(report.skippedAlreadyDone).toBe(1);
      expect(report.limitSkipped).toBe(1);
      expect(report.succeeded).toBe(1);
    });
  });

  describe("embedding lane guard (M-1)", () => {
    it("refuses to proceed when stored prose lane mismatches runtime embedder without --force-embed", async () => {
      await store.insertSession(
        baseRecord({ id: "sess_guard", startedAt: "2026-01-01T10:00:00Z" }),
      );
      storage.embeddingConfig.upsertLane(
        { lane: "prose", provider: "other-provider", model: "other-model", dim: 384 },
        "2026-01-01T00:00:00Z",
      );

      const db = store.rawDb();
      await expect(
        reprocess(
          {
            db,
            store,
            factStore,
            embedder: fakeEmbedder(),
            classifier: fakeClassifier({
              label: "L",
              summary: "S",
              entities: [],
              decisions: [],
              open: [],
              confidence: 0.9,
              facts: [],
            }),
            classifierDescriptor: { provider: "deepseek", model: "current-model" },
            embeddingConfig: storage.embeddingConfig,
            embedderDescriptor: { provider: "ollama", model: "nomic-embed-text" },
          },
          { statePath: join(stateTmp, "reprocess.state") },
        ),
      ).rejects.toThrow("prose embedding lane mismatch");
    });

    it("proceeds with --force-embed when stored lane mismatches runtime embedder", async () => {
      await store.insertSession(
        baseRecord({ id: "sess_force", startedAt: "2026-01-01T10:00:00Z" }),
      );
      storage.embeddingConfig.upsertLane(
        { lane: "prose", provider: "other-provider", model: "other-model", dim: 384 },
        "2026-01-01T00:00:00Z",
      );

      const db = store.rawDb();
      const report = await reprocess(
        {
          db,
          store,
          factStore,
          embedder: fakeEmbedder(),
          classifier: fakeClassifier({
            label: "L",
            summary: "S",
            entities: [],
            decisions: [],
            open: [],
            confidence: 0.9,
            facts: [],
          }),
          classifierDescriptor: { provider: "deepseek", model: "current-model" },
          embeddingConfig: storage.embeddingConfig,
          embedderDescriptor: { provider: "ollama", model: "nomic-embed-text" },
        },
        { statePath: join(stateTmp, "reprocess.state"), forceEmbed: true },
      );

      expect(report.succeeded).toBe(1);
    });

    it("proceeds silently when stored lane matches runtime embedder", async () => {
      await store.insertSession(
        baseRecord({ id: "sess_match", startedAt: "2026-01-01T10:00:00Z" }),
      );
      storage.embeddingConfig.upsertLane(
        { lane: "prose", provider: "ollama", model: "nomic-embed-text", dim: 768 },
        "2026-01-01T00:00:00Z",
      );

      const db = store.rawDb();
      const report = await reprocess(
        {
          db,
          store,
          factStore,
          embedder: fakeEmbedder(),
          classifier: fakeClassifier({
            label: "L",
            summary: "S",
            entities: [],
            decisions: [],
            open: [],
            confidence: 0.9,
            facts: [],
          }),
          classifierDescriptor: { provider: "deepseek", model: "current-model" },
          embeddingConfig: storage.embeddingConfig,
          embedderDescriptor: { provider: "ollama", model: "nomic-embed-text" },
        },
        { statePath: join(stateTmp, "reprocess.state") },
      );

      expect(report.succeeded).toBe(1);
    });
  });
});
