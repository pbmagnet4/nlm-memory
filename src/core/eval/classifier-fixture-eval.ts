import { readFileSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import type { ClassifyResult } from "@ports/llm-client.js";
import { ClassifierSchemaError } from "@ports/llm-client.js";
import { rate } from "@core/eval/extraction-scoring.js";

export interface FixtureEvalResult {
  readonly perTranscript: ReadonlyArray<{
    readonly id: string;
    readonly schemaValid: boolean;
    readonly labelMatch: boolean;
    readonly entityPrecision: number;
    readonly entityRecall: number;
    readonly decisionPrecision: number;
    readonly decisionRecall: number;
    readonly confidence: number;
    readonly confidenceCalibrated: boolean;
    readonly elapsedMs: number;
  }>;
  readonly aggregate: {
    readonly schemaValidRate: number;
    readonly labelAccuracy: number;
    readonly entityF1: number;
    readonly decisionF1: number;
    readonly confidenceCalibrationRate: number;
    readonly p50LatencyMs: number;
    readonly p95LatencyMs: number;
  };
}

interface FixtureRef {
  readonly id: string;
  readonly label: string;
  readonly labelAlternates: ReadonlyArray<string>;
  readonly entities: ReadonlyArray<string>;
  readonly decisions: ReadonlyArray<string>;
  readonly expectLowConfidence: boolean;
}

function loadReference(fixturesDir: string): ReadonlyArray<FixtureRef> {
  const raw = readFileSync(join(fixturesDir, "reference.json"), "utf-8");
  return JSON.parse(raw) as FixtureRef[];
}

function loadTranscript(fixturesDir: string, id: string): string {
  return readFileSync(join(fixturesDir, "transcripts", `${id}.txt`), "utf-8");
}

function listTranscriptIds(fixturesDir: string): string[] {
  const dir = join(fixturesDir, "transcripts");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".txt"))
    .map((f) => basename(f, ".txt"))
    .sort();
}

function normalizeStr(s: string): string {
  return s.toLowerCase().trim();
}

function labelMatches(extracted: string, ref: FixtureRef): boolean {
  const e = normalizeStr(extracted);
  const candidates = [ref.label, ...ref.labelAlternates].map(normalizeStr);
  for (const c of candidates) {
    if (e === c) return true;
    if (e.includes(c) || c.includes(e)) return true;
    if (keyTokenOverlap(e, c) >= 0.5) return true;
  }
  return false;
}

function keyTokenOverlap(a: string, b: string): number {
  const tokA = keyTokens(a);
  const tokB = keyTokens(b);
  if (tokA.size === 0 || tokB.size === 0) return 0;
  let hits = 0;
  for (const t of tokA) if (tokB.has(t)) hits++;
  return hits / Math.max(tokA.size, tokB.size);
}

function keyTokens(s: string): Set<string> {
  const STOPWORDS = new Set([
    "a", "an", "the", "and", "or", "for", "to", "of", "in", "on", "with",
    "at", "by", "from", "up", "as", "is", "it", "its", "into", "that",
    "this", "be", "are", "was", "were", "has", "have", "had",
  ]);
  return new Set(
    s
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 3 && !STOPWORDS.has(t)),
  );
}

function entityMatchesAny(
  refEntity: string,
  extracted: ReadonlyArray<string>,
): boolean {
  const rn = normalizeStr(refEntity);
  for (const e of extracted) {
    const en = normalizeStr(e);
    if (en === rn || en.includes(rn) || rn.includes(en)) return true;
  }
  return false;
}

function decisionMatchesAny(
  refDecision: string,
  extracted: ReadonlyArray<string>,
): boolean {
  const refToks = keyTokens(normalizeStr(refDecision));
  if (refToks.size === 0) return extracted.length > 0;
  for (const e of extracted) {
    const eToks = keyTokens(normalizeStr(e));
    let hits = 0;
    for (const t of refToks) if (eToks.has(t)) hits++;
    if (refToks.size > 0 && hits / refToks.size >= 0.5) return true;
  }
  return false;
}

function scoreEntityPrecision(
  extracted: ReadonlyArray<string>,
  reference: ReadonlyArray<string>,
): number {
  if (extracted.length === 0) return reference.length === 0 ? 1 : 0;
  const hits = extracted.filter((e) => entityMatchesAny(e, reference));
  return hits.length / extracted.length;
}

function scoreEntityRecall(
  extracted: ReadonlyArray<string>,
  reference: ReadonlyArray<string>,
): number {
  if (reference.length === 0) return 1;
  const verdicts = reference.map((r) => entityMatchesAny(r, extracted));
  return (rate(verdicts, Boolean) ?? 0);
}

function scoreDecisionPrecision(
  extracted: ReadonlyArray<string>,
  reference: ReadonlyArray<string>,
): number {
  if (extracted.length === 0) return reference.length === 0 ? 1 : 0;
  const hits = extracted.filter((e) => decisionMatchesAny(e, reference));
  return hits.length / extracted.length;
}

function scoreDecisionRecall(
  extracted: ReadonlyArray<string>,
  reference: ReadonlyArray<string>,
): number {
  if (reference.length === 0) return 1;
  const verdicts = reference.map((r) => decisionMatchesAny(r, extracted));
  return (rate(verdicts, Boolean) ?? 0);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.floor((p / 100) * (sorted.length - 1));
  return sorted[idx] ?? 0;
}

function f1(precision: number, recall: number): number {
  const denom = precision + recall;
  if (denom === 0) return 0;
  return (2 * precision * recall) / denom;
}

function macroF1(perRow: ReadonlyArray<{ p: number; r: number }>): number {
  if (perRow.length === 0) return 0;
  const sum = perRow.reduce((acc, x) => acc + f1(x.p, x.r), 0);
  return sum / perRow.length;
}

export async function runClassifierFixtureEval(
  classify: (transcript: string) => Promise<ClassifyResult>,
  fixturesDir: string,
  opts?: { readonly limit?: number },
): Promise<FixtureEvalResult> {
  const allRefs = loadReference(fixturesDir);
  const allIds = listTranscriptIds(fixturesDir);

  const refById = new Map(allRefs.map((r) => [r.id, r]));
  const ids = opts?.limit != null ? allIds.slice(0, opts.limit) : allIds;

  const perTranscript: Array<FixtureEvalResult["perTranscript"][number]> = [];

  for (const id of ids) {
    const ref = refById.get(id);
    if (ref === undefined) continue;

    const transcript = loadTranscript(fixturesDir, id);
    const start = Date.now();

    let result: ClassifyResult | null = null;
    let schemaValid = true;

    try {
      result = await classify(transcript);
    } catch (err) {
      if (err instanceof ClassifierSchemaError) {
        schemaValid = false;
      } else {
        throw err;
      }
    }

    const elapsedMs = Date.now() - start;

    if (!schemaValid || result === null) {
      perTranscript.push({
        id,
        schemaValid: false,
        labelMatch: false,
        entityPrecision: 0,
        entityRecall: 0,
        decisionPrecision: 0,
        decisionRecall: 0,
        confidence: 0,
        confidenceCalibrated: false,
        elapsedMs,
      });
      continue;
    }

    const lm = labelMatches(result.label, ref);
    const ep = scoreEntityPrecision(result.entities, ref.entities);
    const er = scoreEntityRecall(result.entities, ref.entities);
    const dp = scoreDecisionPrecision(result.decisions, ref.decisions);
    const dr = scoreDecisionRecall(result.decisions, ref.decisions);
    const confidence = result.confidence;

    const confidenceCalibrated = ref.expectLowConfidence
      ? confidence <= 0.4
      : confidence > 0.4;

    perTranscript.push({
      id,
      schemaValid: true,
      labelMatch: lm,
      entityPrecision: ep,
      entityRecall: er,
      decisionPrecision: dp,
      decisionRecall: dr,
      confidence,
      confidenceCalibrated,
      elapsedMs,
    });
  }

  const n = perTranscript.length;
  const schemaValidRate = n === 0 ? 0 : perTranscript.filter((r) => r.schemaValid).length / n;
  const labelAccuracy = n === 0 ? 0 : perTranscript.filter((r) => r.labelMatch).length / n;
  const confidenceCalibrationRate = n === 0 ? 0 : perTranscript.filter((r) => r.confidenceCalibrated).length / n;

  const entityF1 = macroF1(perTranscript.map((r) => ({ p: r.entityPrecision, r: r.entityRecall })));
  const decisionF1 = macroF1(perTranscript.map((r) => ({ p: r.decisionPrecision, r: r.decisionRecall })));

  const sortedLatency = [...perTranscript.map((r) => r.elapsedMs)].sort((a, b) => a - b);
  const p50LatencyMs = percentile(sortedLatency, 50);
  const p95LatencyMs = percentile(sortedLatency, 95);

  return {
    perTranscript,
    aggregate: {
      schemaValidRate,
      labelAccuracy,
      entityF1,
      decisionF1,
      confidenceCalibrationRate,
      p50LatencyMs,
      p95LatencyMs,
    },
  };
}
