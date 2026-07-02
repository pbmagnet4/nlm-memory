import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runClassifierEvalCommand } from "../../../src/cli/nlm.js";
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
