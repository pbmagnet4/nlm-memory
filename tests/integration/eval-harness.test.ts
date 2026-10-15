/**
 * End-to-end test of the shared eval harness over an invented corpus: build a
 * store, snapshot it, derive goldens from synthetic logs, run the metric suite
 * in keyword mode (no embedder), and compare two runs. No real data.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import { createSnapshot } from "../../src/core/eval/harness/snapshot.js";
import { buildGoldens, runHarness, type HarnessReport } from "../../src/core/eval/harness/run.js";
import { compareReports } from "../../src/core/eval/harness/compare.js";
import type { EmbedResult, LLMClient } from "../../src/ports/llm-client.js";
import { LLMUnreachableError } from "../../src/ports/llm-client.js";
import { GOLDEN_CORPUS } from "../fixtures/golden-corpus.js";
import { makeFact } from "../fixtures/facts.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

class UnreachableEmbedder implements LLMClient {
  async embed(): Promise<EmbedResult> {
    throw new LLMUnreachableError("ollama");
  }
  async rewriteForRecall(): Promise<never> {
    throw new Error("unused");
  }
  nameWorkstream(): Promise<string | null> {
    throw new Error("unused");
  }
  async classify(): Promise<never> {
    throw new Error("unused");
  }
}

const lines = (...rows: object[]): string => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

describe("eval harness (synthetic corpus)", () => {
  let tmp: string;
  let snapshotDir: string;
  let report: HarnessReport;

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-harness-"));
    const storage = SqliteStorage.create({ dbPath: join(tmp, "canonical.sqlite"), migrationsDir: MIGRATIONS_DIR });
    for (const s of GOLDEN_CORPUS) storage.sessions.insertSessionForTest(s);
    const facts = [
      { id: "f_db", subject: "widget-app", predicate: "database", value: "Postgres" },
      { id: "f_cache", subject: "widget-app", predicate: "cache layer", value: "Redis" },
      { id: "f_queue", subject: "widget-app", predicate: "job queue", value: "BullMQ" },
      { id: "f_dup1", subject: "widget-app", predicate: "owner", value: "team a" },
      { id: "f_dup2", subject: "widget-app", predicate: "owner", value: "team b" },
    ];
    for (const f of facts) {
      await storage.facts.insert("team_local", makeFact({ ...f, sourceSessionId: GOLDEN_CORPUS[0]!.id }));
    }
    await storage.close();

    // Logs: two queries whose returned sessions are later cited in the same
    // conversation, one uncited query, one citation with no matching query.
    const logsDir = join(tmp, "logs");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(logsDir);
    writeFileSync(
      join(logsDir, "query_log.jsonl"),
      lines(
        { ts: "2026-01-01T00:00:00Z", source: "mcp", query: "FTS5 versus pgvector recall backend", conversation_id: "c1", returned_ids: ["g_pgvector", "g_fts"] },
        { ts: "2026-01-01T00:01:00Z", source: "hook", query: "Hono router port", conversation_id: "c1", returned_ids: ["g_hono"] },
        { ts: "2026-01-01T00:02:00Z", source: "mcp", query: "Tauri desktop packaging", conversation_id: "c2", returned_ids: ["g_tauri"] },
        { ts: "2026-01-01T00:03:00Z", source: "mcp", query: "no conversation id", returned_ids: ["g_fts"] },
      ),
    );
    writeFileSync(join(logsDir, "fact_query_log.jsonl"), lines({ ts: "2026-01-01T00:00:00Z", source: "mcp", query: "database", returned_ids: ["f_db"] }));
    writeFileSync(
      join(logsDir, "citation-log.jsonl"),
      lines(
        { ts: "2026-01-01T00:00:30Z", conversation_id: "c1", cited_id: "g_fts", kind: "tool_use" },
        { ts: "2026-01-01T00:01:30Z", conversation_id: "c1", cited_id: "g_hono", kind: "prose" },
        { ts: "2026-01-01T00:00:10Z", conversation_id: "c2", cited_id: "g_tauri", kind: "tool_use" },
      ),
    );
    writeFileSync(
      join(logsDir, "hook-log.jsonl"),
      lines(
        { ts: "2026-01-01T00:00:00Z", conversationId: "c1", gate: "evaluate", hits: [], wouldInject: ["g_fts"], estTokens: 120 },
        { ts: "2026-01-01T00:01:00Z", conversationId: "c1", gate: "evaluate", hits: [], wouldInject: [], estTokens: 0 },
        { ts: "2026-01-01T00:02:00Z", kind: "stop", conversationId: "c1", citedIds: ["g_fts"] },
      ),
    );

    snapshotDir = join(tmp, "snap");
    await createSnapshot({ sourceDb: join(tmp, "canonical.sqlite"), logsDir, outDir: snapshotDir });
  });

  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it("refuses to overwrite an existing snapshot", async () => {
    await expect(
      createSnapshot({ sourceDb: join(tmp, "canonical.sqlite"), logsDir: tmp, outDir: snapshotDir }),
    ).rejects.toThrow(/already exists/);
  });

  it("derives citation goldens only from later citations of returned ids", () => {
    const g = buildGoldens(snapshotDir);
    const byQuery = new Map(g.session.map((x) => [x.query, x]));
    expect(byQuery.get("FTS5 versus pgvector recall backend")?.relevantIds).toEqual(["g_fts"]);
    expect(byQuery.get("Hono router port")?.relevantIds).toEqual(["g_hono"]);
    // Cited before the query ran, and a query with no conversation id: no label.
    expect(byQuery.has("Tauri desktop packaging")).toBe(false);
    expect(byQuery.has("no conversation id")).toBe(false);
    expect(g.session.every((x) => x.split === "dev" || x.split === "heldout")).toBe(true);
    // Only the unique (subject, predicate) facts qualify; the two owners conflict.
    expect(g.factTopic.map((x) => x.relevantIds[0]).sort()).toEqual(["f_cache", "f_db", "f_queue"]);
    expect(g.factCitation).toHaveLength(0);
    expect(existsSync(join(snapshotDir, "goldens.json"))).toBe(true);
  });

  it("splits deterministically", () => {
    const a = buildGoldens(snapshotDir, { now: new Date(0) });
    const b = buildGoldens(snapshotDir, { now: new Date(1) });
    expect(a.session.map((x) => [x.query, x.split])).toEqual(b.session.map((x) => [x.query, x.split]));
  });

  it("runs the metric suite end to end", async () => {
    report = await runHarness(snapshotDir, { modes: ["keyword"], embedder: new UnreachableEmbedder() });
    const all = ["dev", "heldout"] as const;
    const nSession = all.reduce((s, k) => s + (report.retrieval.session[k]["keyword"]?.n ?? 0), 0);
    const nFact = all.reduce((s, k) => s + (report.retrieval.fact[k]["keyword"]?.n ?? 0), 0);
    expect(nSession).toBe(2);
    expect(nFact).toBe(3);
    expect(report.store.activeFacts).toBe(5);
    expect(report.store.conflictingActiveFacts).toBe(1);
    expect(report.store.activeFactsMissingEmbedding).toBe(5);
    expect(report.hookTokens).toMatchObject({ calls: 2, injectingCalls: 1, p95Injecting: 120 });
    expect(report.classifyLatency).toBeNull();
    expect(Object.keys(report.store.dbBytesByTable)).toContain("sessions");
    expect(report.reDerivation.windowDays).toBe(90);
    expect(Array.isArray(report.citation.perSource)).toBe(true);
  });

  it("flags a fact R@1 regression in compare and passes an identical run", () => {
    const same = compareReports(report, report);
    expect(same.factR1Regressions).toHaveLength(0);
    const worse: HarnessReport = JSON.parse(JSON.stringify(report));
    for (const split of ["dev", "heldout"] as const) {
      const m = worse.retrieval.fact[split]["keyword"];
      if (m) (worse.retrieval.fact[split]["keyword"] as { rAt1: number }).rAt1 = m.rAt1 - 0.1;
    }
    expect(compareReports(report, worse).factR1Regressions.length).toBeGreaterThan(0);
    expect(readFileSync(join(snapshotDir, "goldens.json"), "utf8").length).toBeGreaterThan(10);
  });
});
