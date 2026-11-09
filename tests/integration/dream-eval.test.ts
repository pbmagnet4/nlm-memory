/**
 * Dream-eval runner integration test. Drives runDreamEval end to end against a
 * small SYNTHETIC fixture: a fixture DB (opened only through the runner's
 * sandbox copy), re-derivation labels + sample, fact-judge labels, and
 * hook/citation logs. Asserts the report files land in the out dir with the
 * expected metric keys and hand-computed values. No client/home/infra data and
 * no model anywhere — every label here is a literal in this file.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import { runDreamEval, type DreamEvalReport } from "../../scripts/eval/dream-eval.js";
import { makeFact } from "../fixtures/facts.js";
import { makeSession } from "../fixtures/sessions.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

const jsonl = (...rows: object[]): string => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

describe("dream-eval runner (synthetic fixture)", () => {
  let tmp: string;
  let report: DreamEvalReport;
  let jsonPath: string;
  let mdPath: string;
  let dbPath: string;
  let dbHashBefore: string;

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-dream-eval-test-"));

    // Fixture DB: 3 facts (1 superseded) + 2 sessions, via the real storage.
    dbPath = join(tmp, "canonical.sqlite");
    const storage = SqliteStorage.create({ dbPath, migrationsDir: MIGRATIONS_DIR });
    storage.sessions.insertSessionForTest(makeSession({ id: "s1", label: "Session one" }));
    storage.sessions.insertSessionForTest(makeSession({ id: "s2", label: "Session two" }));
    await storage.facts.insert(
      "team_local",
      makeFact({ id: "f1", subject: "widget-app", predicate: "database", value: "Postgres", sourceSessionId: "s1" }),
    );
    await storage.facts.insert(
      "team_local",
      makeFact({ id: "f2", subject: "widget-app", predicate: "cache", value: "Redis", sourceSessionId: "s1" }),
    );
    await storage.facts.insert(
      "team_local",
      makeFact({
        id: "f3",
        subject: "widget-app",
        predicate: "queue",
        value: "BullMQ",
        supersededBy: "f2",
        sourceSessionId: "s2",
      }),
    );
    await storage.close();
    dbHashBefore = sha256(readFileSync(dbPath));

    // Re-derivation labels: p1 GENUINE (Jan 1), p2 REVISIT (Jan 1),
    // p3 null verdict (excluded). Window = 1 day → one window on Jan 1.
    const rederivDir = join(tmp, "re-derivation");
    mkdirSync(rederivDir, { recursive: true });
    writeFileSync(
      join(rederivDir, "sample.jsonl"),
      jsonl(
        { pairId: "p1", stratum: "A1", a: { startedAt: "2026-01-01T02:00:00Z", label: "ea", decisions: [], excerpt: "" }, b: { startedAt: "2026-01-02T02:00:00Z", label: "eb", decisions: [], excerpt: "" } },
        { pairId: "p2", stratum: "A1", a: { startedAt: "2026-01-01T03:00:00Z", label: "ec", decisions: [], excerpt: "" }, b: { startedAt: "2026-01-01T09:00:00Z", label: "ed", decisions: [], excerpt: "" } },
        { pairId: "p3", stratum: "A2", a: { startedAt: "2026-01-01T04:00:00Z", label: "ee", decisions: [], excerpt: "" }, b: { startedAt: "2026-01-01T10:00:00Z", label: "ef", decisions: [], excerpt: "" } },
      ),
    );
    writeFileSync(
      join(rederivDir, "labels.jsonl"),
      jsonl(
        { pairId: "p1", stratum: "A1", verdict: { label: "GENUINE", confidence: 0.9, reason: "r" } },
        { pairId: "p2", stratum: "A1", verdict: { label: "REVISIT", confidence: 0.8, reason: "r" } },
        { pairId: "p3", stratum: "A2", verdict: null },
      ),
    );

    // Fact-judge labels:
    //  j1 SUPERSEDE_OLD judged correct (mutating TP for precision)
    //  j2 SKIP_NEW judged incorrect (mutating FP for precision, wrong-merge for merge arm)
    // j3 KEEP_BOTH but labeler independently resolved SKIP_NEW (gold mutating missed → recall FN)
    //  j4 SKIP_NEW with null verdict (verdict excluded from precision; merge excluded=1;
    //     its mutating independent still counts as a gold positive the judge hit)
    // → correction: precision 1/2, recall 1/2; merge: 0/1 correct, 1 excluded.
    const judgeLabelsPath = join(tmp, "judge", "labels.json");
    mkdirSync(join(tmp, "judge"), { recursive: true });
    writeFileSync(
      judgeLabelsPath,
      JSON.stringify({
        summary: {},
        items: [
          { newId: "n1", arm: "conflict", action: "SUPERSEDE_OLD", decision: "SUPERSEDE_OLD f1", labeler: { independent: "SUPERSEDE_OLD f1", verdict: "correct" } },
          { newId: "n2", arm: "conflict", action: "SKIP_NEW", decision: "SKIP_NEW f1", labeler: { independent: "KEEP_BOTH", verdict: "incorrect" } },
          { newId: "n3", arm: "other", action: "KEEP_BOTH", decision: "KEEP_BOTH", labeler: { independent: "SKIP_NEW f2", verdict: null } },
          { newId: "n4", arm: "other", action: "SKIP_NEW", decision: "SKIP_NEW f2", labeler: { independent: "SKIP_NEW f2", verdict: null } },
        ],
      }),
    );

    // Telemetry: one fire with 2 hits / 100 tokens (c1, one hit cited),
    // one fires-with-no-hits row that must be skipped (c2).
    const logsDir = join(tmp, "logs");
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(
      join(logsDir, "hook-log.jsonl"),
      jsonl(
        { ts: "2026-01-01T00:00:00Z", conversationId: "c1", gate: "inject", hits: [{ id: "h1", score: 0.9 }, { id: "h2", score: 0.5 }], wouldInject: ["h1", "h2"], estTokens: 100, mode: "live" },
        { ts: "2026-01-01T00:01:00Z", conversationId: "c2", gate: "inject", hits: [], wouldInject: [], estTokens: 50, mode: "live" },
      ),
    );
    writeFileSync(
      join(logsDir, "citation-log.jsonl"),
      jsonl({ ts: "2026-01-01T00:00:30Z", conversation_id: "c1", cited_id: "h1", kind: "tool_use" }),
    );

    const out = runDreamEval({
      dbPath,
      rederivDir,
      labelsName: "labels.jsonl",
      factJudgeLabelsPath: judgeLabelsPath,
      logsDir,
      outDir: join(tmp, "reports", "dream-eval"),
      windowDays: 1,
    });
    report = out.report;
    jsonPath = out.jsonPath;
    mdPath = out.mdPath;
  });

  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it("writes report.json and report.md into the out dir", () => {
    expect(existsSync(jsonPath)).toBe(true);
    expect(existsSync(mdPath)).toBe(true);
    const onDisk = JSON.parse(readFileSync(jsonPath, "utf8")) as DreamEvalReport;
    expect(onDisk.metrics).toEqual(report.metrics);
    const md = readFileSync(mdPath, "utf8");
    for (const heading of [
      "Re-derivation rate over time",
      "Correction precision / recall",
      "Merge precision",
      "Injection cost per useful hit",
    ]) {
      expect(md).toContain(heading);
    }
  });

  it("emits all four metric families with the expected keys and values", () => {
    const m = report.metrics;
    expect(Object.keys(m).sort()).toEqual(["correction", "injection", "merge", "reDerivation"]);
    expect(report.warnings).toEqual([]);

    expect(Object.keys(m.reDerivation!).sort()).toEqual([
      "excluded",
      "overallRate",
      "totalJudged",
      "totalPositives",
      "windows",
    ]);
    expect(m.reDerivation!.totalJudged).toBe(2);
    expect(m.reDerivation!.totalPositives).toBe(1);
    expect(m.reDerivation!.overallRate).toBeCloseTo(0.5);
    expect(m.reDerivation!.excluded).toBe(1);
    expect(m.reDerivation!.windows).toHaveLength(1);
    expect(m.reDerivation!.windows[0]).toMatchObject({ judged: 2, positives: 1 });

    // j3 is not a predicted mutation, so its null verdict is NOT verdictUnparsed;
    // only j4 (predicted SKIP_NEW, null verdict) is.
    expect(m.correction).toMatchObject({
      mutatingJudged: 2,
      mutatingCorrect: 1,
      goldMutating: 3,
      truePositives: 2,
      independentUnparsed: 0,
      verdictUnparsed: 1,
    });
    expect(m.correction!.precision).toBeCloseTo(0.5);
    expect(m.correction!.recall).toBeCloseTo(2 / 3);

    expect(m.merge).toMatchObject({ merges: 1, correct: 0, excluded: 1 });
    expect(m.merge!.precision).toBe(0);

    expect(m.injection).toMatchObject({ fires: 1, injectedTokens: 100, usefulHits: 1 });
    expect(m.injection!.tokensPerUsefulHit).toBe(100);
  });

  it("reads corpus stats without touching the source DB file", () => {
    expect(report.db).toMatchObject({ facts: 3, activeFacts: 2, sessions: 2 });
    // The runner only ever opens a sandbox copy: the fixture file is byte-identical.
    expect(sha256(readFileSync(dbPath))).toBe(dbHashBefore);
  });
});
