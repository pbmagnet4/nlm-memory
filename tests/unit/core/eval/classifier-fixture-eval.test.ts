import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runClassifierFixtureEval } from "@core/eval/classifier-fixture-eval.js";
import type { ClassifyResult } from "@ports/llm-client.js";
import { ClassifierSchemaError } from "@ports/llm-client.js";

const FIXTURES_DIR = join(
  fileURLToPath(new URL("../../../../", import.meta.url)),
  "tests/fixtures/classifier-gold",
);

interface RefEntry {
  id: string;
  label: string;
  labelAlternates: string[];
  entities: string[];
  decisions: string[];
  expectLowConfidence: boolean;
}

function loadRefs(): RefEntry[] {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, "reference.json"), "utf-8")) as RefEntry[];
}

function loadTranscriptMap(refs: RefEntry[]): Map<string, RefEntry> {
  const map = new Map<string, RefEntry>();
  for (const ref of refs) {
    const txt = readFileSync(join(FIXTURES_DIR, "transcripts", `${ref.id}.txt`), "utf-8");
    map.set(txt, ref);
  }
  return map;
}

function makeResult(overrides: Partial<ClassifyResult> = {}): ClassifyResult {
  return {
    label: "placeholder label",
    summary: "placeholder summary",
    entities: [],
    decisions: [],
    open: [],
    confidence: 0.8,
    facts: [],
    ...overrides,
  };
}

describe("runClassifierFixtureEval", () => {
  describe("perfect stub", () => {
    it("scores 1.0 on all metrics when classify returns exact reference values per transcript", async () => {
      const refs = loadRefs();
      const byTranscript = loadTranscriptMap(refs);

      const result = await runClassifierFixtureEval(
        async (transcript: string): Promise<ClassifyResult> => {
          const ref = byTranscript.get(transcript);
          if (!ref) return makeResult();
          return makeResult({
            label: ref.label,
            entities: [...ref.entities],
            decisions: [...ref.decisions],
            confidence: ref.expectLowConfidence ? 0.2 : 0.9,
          });
        },
        FIXTURES_DIR,
      );

      expect(result.perTranscript).toHaveLength(20);
      expect(result.aggregate.schemaValidRate).toBe(1);
      expect(result.aggregate.labelAccuracy).toBe(1);
      expect(result.aggregate.entityF1).toBeCloseTo(1);
      expect(result.aggregate.decisionF1).toBeCloseTo(1);
      expect(result.aggregate.confidenceCalibrationRate).toBe(1);

      for (const row of result.perTranscript) {
        expect(row.schemaValid).toBe(true);
        expect(row.labelMatch).toBe(true);
        expect(row.entityPrecision).toBe(1);
        expect(row.entityRecall).toBe(1);
        expect(row.decisionPrecision).toBe(1);
        expect(row.decisionRecall).toBe(1);
        expect(row.confidenceCalibrated).toBe(true);
      }
    });
  });

  describe("garbage stub", () => {
    it("scores 0 recall on substantive transcripts when classify returns unrelated strings", async () => {
      const refs = loadRefs();
      const substantiveIds = new Set(
        refs.filter((r) => r.entities.length > 0 || r.decisions.length > 0).map((r) => r.id),
      );

      const result = await runClassifierFixtureEval(
        async (_: string): Promise<ClassifyResult> =>
          makeResult({
            label: "zzzgarbage",
            entities: ["xyzzy-nonexistent-q"],
            decisions: ["zzzqqqz took some random unrelated action zzz"],
            confidence: 0.9,
          }),
        FIXTURES_DIR,
      );

      expect(result.aggregate.schemaValidRate).toBe(1);
      expect(result.aggregate.labelAccuracy).toBe(0);

      for (const row of result.perTranscript) {
        if (!substantiveIds.has(row.id)) continue;
        expect(row.entityRecall).toBe(0);
        expect(row.decisionRecall).toBe(0);
      }
    });
  });

  describe("schema error stub", () => {
    it("counts ClassifierSchemaError as schemaValid=false with zeroed metrics, does not throw", async () => {
      const result = await runClassifierFixtureEval(
        async (_: string): Promise<ClassifyResult> => {
          throw new ClassifierSchemaError("test: malformed response");
        },
        FIXTURES_DIR,
        { limit: 4 },
      );

      expect(result.perTranscript).toHaveLength(4);
      expect(result.aggregate.schemaValidRate).toBe(0);

      for (const row of result.perTranscript) {
        expect(row.schemaValid).toBe(false);
        expect(row.labelMatch).toBe(false);
        expect(row.entityPrecision).toBe(0);
        expect(row.entityRecall).toBe(0);
        expect(row.decisionPrecision).toBe(0);
        expect(row.decisionRecall).toBe(0);
        expect(row.confidence).toBe(0);
        expect(row.confidenceCalibrated).toBe(false);
      }
    });

    it("does not swallow non-schema errors", async () => {
      await expect(
        runClassifierFixtureEval(
          async (_: string): Promise<ClassifyResult> => {
            throw new Error("unexpected infrastructure failure");
          },
          FIXTURES_DIR,
          { limit: 1 },
        ),
      ).rejects.toThrow("unexpected infrastructure failure");
    });
  });

  describe("confidence calibration", () => {
    it("marks low-signal transcripts calibrated when confidence <= 0.4", async () => {
      const refs = loadRefs();
      const lowIds = new Set(refs.filter((r) => r.expectLowConfidence).map((r) => r.id));
      const byTranscript = loadTranscriptMap(refs);

      const result = await runClassifierFixtureEval(
        async (transcript: string): Promise<ClassifyResult> => {
          const ref = byTranscript.get(transcript);
          const isLow = ref !== undefined && lowIds.has(ref.id);
          return makeResult({ confidence: isLow ? 0.3 : 0.85 });
        },
        FIXTURES_DIR,
      );

      expect(result.aggregate.confidenceCalibrationRate).toBe(1);
      for (const row of result.perTranscript) {
        expect(row.confidenceCalibrated).toBe(true);
      }
    });

    it("marks low-signal transcripts NOT calibrated when confidence > 0.4", async () => {
      const refs = loadRefs();
      const lowIds = new Set(refs.filter((r) => r.expectLowConfidence).map((r) => r.id));

      const result = await runClassifierFixtureEval(
        async (_: string): Promise<ClassifyResult> =>
          makeResult({ confidence: 0.85 }),
        FIXTURES_DIR,
      );

      const lowRows = result.perTranscript.filter((row) => lowIds.has(row.id));
      expect(lowRows.length).toBeGreaterThan(0);
      for (const row of lowRows) {
        expect(row.confidenceCalibrated).toBe(false);
      }
    });

    it("marks substantive transcripts NOT calibrated when confidence <= 0.4", async () => {
      const refs = loadRefs();
      const highIds = new Set(refs.filter((r) => !r.expectLowConfidence).map((r) => r.id));

      const result = await runClassifierFixtureEval(
        async (_: string): Promise<ClassifyResult> =>
          makeResult({ confidence: 0.3 }),
        FIXTURES_DIR,
      );

      const highRows = result.perTranscript.filter((row) => highIds.has(row.id));
      expect(highRows.length).toBeGreaterThan(0);
      for (const row of highRows) {
        expect(row.confidenceCalibrated).toBe(false);
      }
    });
  });

  describe("aggregate and limit", () => {
    it("limit option restricts number of evaluated transcripts", async () => {
      const result = await runClassifierFixtureEval(
        async (_: string): Promise<ClassifyResult> => makeResult({ confidence: 0.9 }),
        FIXTURES_DIR,
        { limit: 5 },
      );

      expect(result.perTranscript).toHaveLength(5);
    });

    it("p95 latency >= p50 latency", async () => {
      const result = await runClassifierFixtureEval(
        async (_: string): Promise<ClassifyResult> => makeResult({ confidence: 0.9 }),
        FIXTURES_DIR,
        { limit: 6 },
      );

      expect(result.aggregate.p50LatencyMs).toBeGreaterThanOrEqual(0);
      expect(result.aggregate.p95LatencyMs).toBeGreaterThanOrEqual(result.aggregate.p50LatencyMs);
    });

    it("entityF1 is above 0.9 when perfect entities returned", async () => {
      const refs = loadRefs();
      const byTranscript = loadTranscriptMap(refs);

      const result = await runClassifierFixtureEval(
        async (transcript: string): Promise<ClassifyResult> => {
          const ref = byTranscript.get(transcript);
          return makeResult({
            entities: ref ? [...ref.entities] : [],
            confidence: ref?.expectLowConfidence ? 0.2 : 0.9,
          });
        },
        FIXTURES_DIR,
      );

      expect(result.aggregate.entityF1).toBeGreaterThan(0.9);
    });
  });
});
