/**
 * Code-exemplar ranking regression gate. A small SYNTHETIC exemplar corpus is
 * ingested into a real SqliteStorage with a DETERMINISTIC stub embedder (no
 * Ollama, no migration), then run through the real recallCode lane. Asserts the
 * core ranking property of the exemplar lane: for a query semantically close to
 * the passing/fixed code, pass/fix exemplars rank above fail/exhausted ones, and
 * the first positive is a pass or fix. A regression in the exemplar lane (vector
 * scoping, outcome partitioning, or ranking) fails CI. Mirrors
 * tests/integration/fact-recall-gate.test.ts for the session/fact lanes.
 *
 * No client/home/infra data: the corpus is invented and committed.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import { normalizeExemplar } from "../../src/core/exemplars/ingest-exemplar.js";
import { recallCode } from "../../src/core/exemplars/recall-code.js";
import type { CodeEmbedder, EmbedCodeResult } from "../../src/ports/code-embedder.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");
const SCOPE = "gate-scope";
const DIM = 768;

// Deterministic unit vectors. "good" query shares its direction with the
// pass/fix code; "bad" direction belongs to fail/exhausted code.
function makeVector(pattern: number[]): Float32Array {
  const v = new Float32Array(DIM);
  for (let i = 0; i < pattern.length; i++) v[i] = pattern[i] ?? 0;
  let sumSq = 0;
  for (let i = 0; i < DIM; i++) sumSq += (v[i] ?? 0) ** 2;
  const norm = Math.sqrt(sumSq) || 1;
  for (let i = 0; i < DIM; i++) v[i] = (v[i] ?? 0) / norm;
  return v;
}

const VECTORS = {
  PASS_CODE: makeVector([1, 0.9, 0.1]),
  FIX_CODE: makeVector([0.95, 0.9, 0.15]),
  FAIL_CODE: makeVector([0.1, 0.2, 1]),
  EXHAUSTED_CODE: makeVector([0.05, 0.1, 0.95]),
  QUERY_GOOD: makeVector([1, 0.9, 0.1]),
} as const;

// Stub embedder: maps any text containing a known marker to its fixed vector.
class StubCodeEmbedder implements CodeEmbedder {
  async embed(text: string, _role: "query" | "document"): Promise<EmbedCodeResult> {
    for (const [key, vec] of Object.entries(VECTORS)) {
      if (text.includes(key)) return { vector: vec, dim: DIM };
    }
    return { vector: makeVector([0.5, 0.5, 0.5]), dim: DIM };
  }
}

interface SeedExemplar {
  marker: keyof typeof VECTORS;
  code: string;
  outcome: "pass" | "fail" | "fix" | "exhausted";
}

const SYNTHETIC_EXEMPLARS: ReadonlyArray<SeedExemplar> = [
  { marker: "PASS_CODE", outcome: "pass", code: "// PASS_CODE\nfunction add(a, b) {\n  return a + b;\n}" },
  { marker: "FIX_CODE", outcome: "fix", code: "// FIX_CODE\nfunction add(a, b) {\n  return Number(a) + Number(b);\n}" },
  { marker: "FAIL_CODE", outcome: "fail", code: "// FAIL_CODE\nfunction add(a, b) {\n  return a - b;\n}" },
  { marker: "EXHAUSTED_CODE", outcome: "exhausted", code: "// EXHAUSTED_CODE\nfunction add(a, b) {\n  return NaN;\n}" },
];

describe("code-exemplar ranking gate", () => {
  let tmp: string;
  let storage: SqliteStorage;
  const embedder = new StubCodeEmbedder();

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-exemplar-gate-"));
    storage = SqliteStorage.create({
      dbPath: join(tmp, "canonical.sqlite"),
      migrationsDir: MIGRATIONS_DIR,
    });
    await storage.init();

    for (const ex of SYNTHETIC_EXEMPLARS) {
      const input = normalizeExemplar({
        installScope: SCOPE,
        repo: "/gate/repo",
        model: "stub",
        taskContext: "add two numbers",
        code: ex.code,
        outcome: ex.outcome,
        ts: new Date().toISOString(),
      });
      const { id, skipped } = await storage.exemplars.insert(input);
      expect(skipped).toBe(false);
      await storage.exemplars.upsertEmbedding(id, VECTORS[ex.marker]);
    }
  });

  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("ranks pass/fix above fail/exhausted for a semantically matching query", async () => {
    const result = await recallCode(
      { query: "QUERY_GOOD add two numbers", installScope: SCOPE, includeNegatives: true, k: 10 },
      storage.exemplars,
      embedder,
      null,
    );

    expect(result.positives.length).toBeGreaterThanOrEqual(1);
    expect(result.negatives.length).toBeGreaterThanOrEqual(1);

    const firstOutcome = result.positives[0]?.outcome;
    expect(firstOutcome === "pass" || firstOutcome === "fix").toBe(true);

    // distance is cosine distance — smaller means closer to the query.
    const topPositiveDistance = result.positives[0]?.distance ?? Infinity;
    const topNegativeDistance = result.negatives[0]?.distance ?? Infinity;
    expect(topPositiveDistance).toBeLessThan(topNegativeDistance);
  });

  it("excludes negatives when include_negatives=false", async () => {
    const result = await recallCode(
      { query: "QUERY_GOOD add two numbers", installScope: SCOPE, includeNegatives: false, k: 10 },
      storage.exemplars,
      embedder,
      null,
    );
    expect(result.negatives.length).toBe(0);
    expect(result.positives.length).toBeGreaterThanOrEqual(1);
  });

  it("isolates by install_scope", async () => {
    const result = await recallCode(
      { query: "QUERY_GOOD add two numbers", installScope: "unrelated-scope", k: 10 },
      storage.exemplars,
      embedder,
      null,
    );
    expect(result.positives.length + result.negatives.length).toBe(0);
  });
});
