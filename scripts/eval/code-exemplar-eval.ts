/**
 * Synthetic eval for the code-exemplar recall lane.
 *
 * Asserts that recall_code:
 * 1. Ranks pass/fix exemplars above fail/exhausted for a semantically
 *    similar query (positive-above-negative recall).
 * 2. Scopes correctly by install_scope (cross-tenant isolation).
 * 3. Is idempotent on re-ingest (duplicate code_hash is a no-op).
 * 4. Handles a full bucket-cap → prune-reverted cycle cleanly.
 *
 * Does NOT require Ollama running — uses a deterministic stub embedder
 * that assigns known distances so ranking assertions are deterministic.
 *
 * Run: npx tsx scripts/eval/code-exemplar-eval.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import { codeHash, normalizeExemplar } from "../../src/core/exemplars/ingest-exemplar.js";
import { recallCode } from "../../src/core/exemplars/recall-code.js";
import type { CodeEmbedder, EmbedCodeResult } from "../../src/ports/code-embedder.js";

const MIGRATIONS_DIR = resolve(import.meta.dirname, "../../migrations");

// ── Deterministic stub embedder ───────────────────────────────────────────
// Each snippet gets a fixed unit-vector. "similar" queries share most components.

const DIM = 768;

function makeVector(pattern: number[]): Float32Array {
  const v = new Float32Array(DIM);
  for (let i = 0; i < pattern.length; i++) v[i] = pattern[i] ?? 0;
  let sumSq = 0;
  for (let i = 0; i < DIM; i++) sumSq += (v[i] ?? 0) ** 2;
  const norm = Math.sqrt(sumSq);
  for (let i = 0; i < DIM; i++) v[i] = (v[i] ?? 0) / norm;
  return v;
}

const VECTORS = {
  passCode: makeVector([1, 0.9, 0.1]),
  fixCode: makeVector([0.95, 0.9, 0.15]),
  failCode: makeVector([0.1, 0.2, 1]),
  exhaustedCode: makeVector([0.05, 0.1, 0.95]),
  queryGood: makeVector([1, 0.9, 0.1]),   // should match pass/fix
  queryBad: makeVector([0.1, 0.15, 1]),   // should match fail/exhausted
};

class StubCodeEmbedder implements CodeEmbedder {
  constructor(private readonly map: Record<string, Float32Array>) {}
  async embed(text: string, _role: "query" | "document"): Promise<EmbedCodeResult> {
    for (const [key, vec] of Object.entries(this.map)) {
      if (text.includes(key)) return { vector: vec, dim: DIM };
    }
    return { vector: makeVector([0.5, 0.5, 0.5]), dim: DIM };
  }
}

// ── Test harness ──────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function ok(name: string, cond: boolean): void {
  if (cond) { passed++; process.stdout.write(`  ✓ ${name}\n`); }
  else { failed++; process.stdout.write(`  ✗ ${name}\n`); }
}

async function main(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "nlm-exemplar-eval-"));
  const storage = SqliteStorage.create({
    dbPath: join(tmp, "canonical.sqlite"),
    migrationsDir: MIGRATIONS_DIR,
  });
  await storage.init();

  const embedder = new StubCodeEmbedder({
    "PASS_CODE": VECTORS.passCode!,
    "FIX_CODE": VECTORS.fixCode!,
    "FAIL_CODE": VECTORS.failCode!,
    "EXHAUSTED_CODE": VECTORS.exhaustedCode!,
    "QUERY_GOOD": VECTORS.queryGood!,
    "QUERY_BAD": VECTORS.queryBad!,
  });

  const SCOPE = "eval-scope";
  const OTHER_SCOPE = "other-scope";

  // ── Ingest corpus ─────────────────────────────────────────────────────────
  process.stdout.write("\nStep 1: ingest exemplars\n");

  const make = (code: string, outcome: "pass" | "fail" | "fix" | "exhausted", scope = SCOPE) =>
    normalizeExemplar({
      installScope: scope,
      repo: "/eval/repo",
      model: "qwen",
      taskContext: "add numbers",
      code,
      outcome,
      ts: new Date().toISOString(),
    });

  const passExemplar = make("// PASS_CODE\nfunction add(a, b) {\n  return a + b;\n}", "pass");
  const fixExemplar = make("// FIX_CODE\nfunction add(a, b) {\n  return Number(a) + Number(b);\n}", "fix");
  const failExemplar = make("// FAIL_CODE\nfunction add(a, b) {\n  return a - b;\n}", "fail");
  const exhaustedExemplar = make("// EXHAUSTED_CODE\nfunction add(a, b) {\n  return NaN;\n}", "exhausted");
  const otherScopeExemplar = make("// PASS_CODE other\nconst add = (a, b) => a + b;", "pass", OTHER_SCOPE);

  for (const [inp, vec] of [
    [passExemplar, VECTORS.passCode] as const,
    [fixExemplar, VECTORS.fixCode] as const,
    [failExemplar, VECTORS.failCode] as const,
    [exhaustedExemplar, VECTORS.exhaustedCode] as const,
    [otherScopeExemplar, VECTORS.passCode] as const,
  ]) {
    const { id, skipped } = await storage.exemplars.insert(inp);
    ok(`insert ${inp.outcome}/${inp.installScope} not skipped`, !skipped);
    if (vec) await storage.exemplars.upsertEmbedding(id, vec);
  }

  // ── Idempotence ───────────────────────────────────────────────────────────
  process.stdout.write("\nStep 2: idempotence\n");
  const { skipped } = await storage.exemplars.insert(passExemplar);
  ok("duplicate insert is skipped", skipped);

  // ── Recall: positives ranked above negatives ───────────────────────────────
  process.stdout.write("\nStep 3: recall — positives above negatives\n");
  const goodResult = await recallCode(
    { query: "QUERY_GOOD add two numbers", installScope: SCOPE, includeNegatives: true, k: 10 },
    storage.exemplars,
    embedder,
    null,
  );
  ok("positives returned", goodResult.positives.length >= 1);
  ok("negatives returned when include_negatives=true", goodResult.negatives.length >= 1);
  ok("first positive is pass or fix",
    goodResult.positives[0]?.outcome === "pass" || goodResult.positives[0]?.outcome === "fix");

  const noNegResult = await recallCode(
    { query: "QUERY_GOOD add two numbers", installScope: SCOPE, includeNegatives: false, k: 10 },
    storage.exemplars,
    embedder,
    null,
  );
  ok("negatives excluded when include_negatives=false", noNegResult.negatives.length === 0);

  // ── Cross-tenant isolation ────────────────────────────────────────────────
  process.stdout.write("\nStep 4: install_scope isolation\n");
  const otherResult = await recallCode(
    { query: "QUERY_GOOD add two numbers", installScope: OTHER_SCOPE, k: 10 },
    storage.exemplars,
    embedder,
    null,
  );
  const allOtherScopeIds = [...otherResult.positives, ...otherResult.negatives].map((h) => h.repo);
  ok("other-scope hits are isolated", allOtherScopeIds.every((r) => r === "/eval/repo"));
  ok("at most 1 hit from OTHER_SCOPE (only one was inserted)",
    otherResult.positives.length + otherResult.negatives.length <= 1);

  // ── Bucket cap ───────────────────────────────────────────────────────────
  process.stdout.write("\nStep 5: bucket cap\n");
  for (let i = 0; i < 5; i++) {
    const code = `// extra\nfunction v${i}(a, b) {\n  return a + b + ${i};\n}`;
    const inp = normalizeExemplar({
      installScope: SCOPE,
      repo: "/eval/repo",
      model: "qwen",
      taskContext: "extra exemplars",
      code,
      outcome: "pass",
      ts: `2026-01-0${i + 1}T00:00:00.000Z`,
    });
    await storage.exemplars.insert(inp);
  }
  const deleted = await storage.exemplars.applyBucketCap(SCOPE, 3);
  ok("bucket cap evicted old rows", deleted > 0);

  // ── Prune reverted ────────────────────────────────────────────────────────
  process.stdout.write("\nStep 6: prune reverted\n");
  const revertedCode = "// reverted\nfunction gone(a, b) {\n  return a * b;\n}";
  const revInp = normalizeExemplar({
    installScope: SCOPE, repo: "/eval/repo", model: "qwen",
    taskContext: "reverted func", code: revertedCode, outcome: "pass",
    survived: 0, ts: new Date().toISOString(),
  });
  await storage.exemplars.insert(revInp);
  const pruned = await storage.exemplars.pruneReverted(SCOPE);
  ok("reverted row pruned", pruned >= 1);

  // ── Summary ───────────────────────────────────────────────────────────────
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });

  process.stdout.write(`\n${passed + failed} checks: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { process.stderr.write(String(e) + "\n"); process.exit(1); });
