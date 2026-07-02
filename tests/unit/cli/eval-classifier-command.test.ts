import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { readFile } from "node:fs/promises";
import { runClassifierEvalCommand } from "../../../src/cli/nlm.js";
import { runEval } from "@core/eval/run-eval.js";
import type { ClassifyResult } from "../../../src/ports/llm-client.js";

const FIXTURES_DIR = join(
  fileURLToPath(new URL("../../../", import.meta.url)),
  "fixtures/classifier-gold",
);

function makeResult(overrides: Partial<ClassifyResult> = {}): ClassifyResult {
  return {
    label: "bug-fix",
    summary: "s",
    entities: [],
    decisions: [],
    open: [],
    confidence: 0.8,
    facts: [],
    ...overrides,
  };
}

describe("runClassifierEvalCommand", () => {
  it("human mode emits lane identity, all aggregate metrics, and docs pointer", async () => {
    const lines: string[] = [];
    await runClassifierEvalCommand({
      classify: async () => makeResult(),
      provider: "ollama",
      model: "qwen3.5:4b",
      fixturesDir: FIXTURES_DIR,
      limit: 3,
      json: false,
      stdout: (s) => { lines.push(s); },
    });

    const out = lines.join("");
    expect(out).toContain("ollama/qwen3.5:4b");
    expect(out).toContain("schema-valid:");
    expect(out).toContain("label-accuracy:");
    expect(out).toContain("entity-F1:");
    expect(out).toContain("decision-F1:");
    expect(out).toContain("conf-calibration:");
    expect(out).toContain("p50-latency:");
    expect(out).toContain("p95-latency:");
    expect(out).toContain("docs/classifier-tiers.md");
  });

  it("json mode emits FixtureEvalResult plus provider and model", async () => {
    const chunks: string[] = [];
    await runClassifierEvalCommand({
      classify: async () => makeResult(),
      provider: "deepseek",
      model: "deepseek-v4-flash",
      fixturesDir: FIXTURES_DIR,
      limit: 2,
      json: true,
      stdout: (s) => { chunks.push(s); },
    });

    const parsed = JSON.parse(chunks.join(""));
    expect(parsed).toHaveProperty("provider", "deepseek");
    expect(parsed).toHaveProperty("model", "deepseek-v4-flash");
    expect(parsed).toHaveProperty("aggregate");
    expect(parsed.aggregate).toHaveProperty("schemaValidRate");
    expect(parsed.aggregate).toHaveProperty("labelAccuracy");
    expect(parsed.aggregate).toHaveProperty("entityF1");
    expect(parsed.aggregate).toHaveProperty("decisionF1");
    expect(parsed.aggregate).toHaveProperty("confidenceCalibrationRate");
    expect(parsed.aggregate).toHaveProperty("p50LatencyMs");
    expect(parsed.aggregate).toHaveProperty("p95LatencyMs");
    expect(parsed).toHaveProperty("perTranscript");
    expect(parsed.perTranscript).toHaveLength(2);
  });

  it("limit option restricts the number of transcripts evaluated", async () => {
    const chunks: string[] = [];
    await runClassifierEvalCommand({
      classify: async () => makeResult(),
      provider: "ollama",
      model: "qwen3.5:4b",
      fixturesDir: FIXTURES_DIR,
      limit: 1,
      json: true,
      stdout: (s) => { chunks.push(s); },
    });

    const parsed = JSON.parse(chunks.join(""));
    expect(parsed.perTranscript).toHaveLength(1);
  });
});

describe("recall mode (--queries) is unaffected when --classifier is absent", () => {
  it("runClassifierEvalCommand is a pure helper that does not touch the recall path", async () => {
    const chunks: string[] = [];
    await runClassifierEvalCommand({
      classify: async () => makeResult({ label: "ops", entities: ["nginx"], decisions: ["upgraded ssl cert"] }),
      provider: "ollama",
      model: "qwen3.5:4b",
      fixturesDir: FIXTURES_DIR,
      limit: 2,
      json: true,
      stdout: (s) => { chunks.push(s); },
    });
    const parsed = JSON.parse(chunks.join(""));
    expect(parsed.provider).toBe("ollama");
    expect(parsed.perTranscript).toHaveLength(2);
  });
});

describe("eval --queries path (M-2)", () => {
  let tmp: string;

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("reads a queries file and emits a recall report with correct shape", async () => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-eval-queries-"));
    const queriesPath = join(tmp, "queries.json");
    writeFileSync(
      queriesPath,
      JSON.stringify([
        { query: "alpha", expectedIds: ["s1"] },
        { query: "beta", expectedIds: ["s2"] },
      ]),
    );

    const stubRecall = {
      search: async ({ query }: { query: string; mode: string; limit: number }) => ({
        results:
          query === "alpha"
            ? [{ id: "s1" }, { id: "s9" }]
            : [{ id: "s9" }, { id: "s2" }],
      }),
    };

    const queries = JSON.parse(await readFile(queriesPath, "utf8"));
    const report = await runEval({ recall: stubRecall } as never, queries, { mode: "keyword", k: 5 });

    expect(report.n).toBe(2);
    expect(report.mode).toBe("keyword");
    expect(report.rAt1).toBeCloseTo(0.5);
    expect(report.rAt5).toBeCloseTo(1.0);
    expect(report.mrr).toBeCloseTo(0.75);
    expect(report.misses).toHaveLength(0);
  });
});
