/**
 * Score-floor calibration for the per-message (keyword) recall hook (#284).
 *
 * The PromptSubmit hook surfaces a pointer block on every prompt; a score floor
 * suppresses low-relevance noise. The question is what threshold cuts noise
 * without dropping useful (cited) recalls — and, crucially, on a scale that
 * PORTS to a client install.
 *
 * Two floor strategies are measured from real telemetry:
 *   - absolute:        keep hits with raw FTS5 score >= T. Best separation on a
 *                      given corpus, but BM25 magnitudes are corpus-specific so a
 *                      fixed T does NOT transfer to another install.
 *   - median-relative: keep hits with (score / fire-median) >= T. Portable
 *                      across installs (a ratio), at a small separation cost.
 *
 * Gold = a session the agent cited (tool_use) in that conversation. Noise = a
 * surfaced-but-uncited hit in a conversation that produced >= 1 citation. Only
 * keyword fires (raw scale) in gold conversations are scored.
 *
 * Usage:
 *   npm run eval:floor                 # last 365d
 *   npx tsx scripts/eval/floor-calibration.ts --days 90 --min-gold 0.95
 */

import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";

export interface FloorFire {
  readonly conversationId: string;
  readonly hits: ReadonlyArray<{ id: string; score: number }>;
}

export interface FloorGold {
  readonly conversationId: string;
  readonly citedId: string;
}

export interface FloorPoint {
  threshold: number;
  goldKept: number;
  noiseCut: number;
}

export interface FloorCalibration {
  goldHits: number;
  noiseHits: number;
  absolute: FloorPoint[];
  medianRelative: FloorPoint[];
  /** Highest median-relative threshold that still keeps >= minGoldKept of gold. */
  recommended: { threshold: number; goldKept: number; noiseCut: number } | null;
}

const ABSOLUTE_THRESHOLDS = [2, 3, 5, 8, 10, 15];
const RELATIVE_THRESHOLDS = [0.3, 0.5, 0.7, 0.8, 0.9, 1.0];

function median(values: ReadonlyArray<number>): number {
  if (values.length === 0) return 1;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 1;
}

export function calibrateFloor(
  fires: ReadonlyArray<FloorFire>,
  gold: ReadonlyArray<FloorGold>,
  minGoldKept = 0.95,
): FloorCalibration {
  const goldByConv = new Map<string, Set<string>>();
  for (const g of gold) {
    if (!goldByConv.has(g.conversationId)) goldByConv.set(g.conversationId, new Set());
    goldByConv.get(g.conversationId)!.add(g.citedId);
  }

  const goldRaw: number[] = [];
  const noiseRaw: number[] = [];
  const goldRel: number[] = [];
  const noiseRel: number[] = [];

  for (const fire of fires) {
    const cited = goldByConv.get(fire.conversationId);
    if (!cited) continue;
    const med = median(fire.hits.map((h) => h.score));
    for (const h of fire.hits) {
      const rel = med > 0 ? h.score / med : 0;
      if (cited.has(h.id)) {
        goldRaw.push(h.score);
        goldRel.push(rel);
      } else {
        noiseRaw.push(h.score);
        noiseRel.push(rel);
      }
    }
  }

  const G = goldRaw.length || 1;
  const N = noiseRaw.length || 1;
  const point = (gv: number[], nv: number[], t: number): FloorPoint => ({
    threshold: t,
    goldKept: gv.filter((s) => s >= t).length / G,
    noiseCut: nv.filter((s) => s < t).length / N,
  });

  const absolute = ABSOLUTE_THRESHOLDS.map((t) => point(goldRaw, noiseRaw, t));
  const medianRelative = RELATIVE_THRESHOLDS.map((t) => point(goldRel, noiseRel, t));

  // Recommend the most aggressive portable (median-relative) floor that still
  // retains at least minGoldKept of gold — i.e. max noise cut under the recall
  // constraint. Null if even the gentlest threshold drops too much gold.
  const eligible = medianRelative.filter((p) => p.goldKept >= minGoldKept);
  const recommended = eligible.length
    ? eligible.reduce((best, p) => (p.noiseCut > best.noiseCut ? p : best))
    : null;

  return {
    goldHits: goldRaw.length,
    noiseHits: noiseRaw.length,
    absolute,
    medianRelative,
    recommended: recommended
      ? { threshold: recommended.threshold, goldKept: recommended.goldKept, noiseCut: recommended.noiseCut }
      : null,
  };
}

// ── I/O glue (skipped under Vitest) ───────────────────────────────────────────

async function readJsonl(path: string): Promise<Array<Record<string, unknown>>> {
  if (!existsSync(path)) return [];
  const rows: Array<Record<string, unknown>> = [];
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) {
    const t = line.trim();
    if (!t) continue;
    try {
      rows.push(JSON.parse(t) as Record<string, unknown>);
    } catch {
      /* skip malformed */
    }
  }
  return rows;
}

const KEYWORD_RAW_SCALE_MIN = 1.5; // fires whose top hit exceeds this are raw-BM25 (keyword) fires

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const numArg = (flag: string, def: number) => {
    const i = args.indexOf(flag);
    return i !== -1 ? Number.parseFloat(args[i + 1] ?? "") || def : def;
  };
  const days = numArg("--days", 365);
  const minGold = numArg("--min-gold", 0.95);
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  const hookLogPath = process.env["NLM_HOOK_LOG"] ?? join(homedir(), ".nlm", "hook-log.jsonl");
  const citationLogPath = process.env["NLM_CITATION_LOG"] ?? join(homedir(), ".nlm", "citation-log.jsonl");
  const ORPHAN = new Set(["mcp_tool", "unknown", ""]);

  const gold: FloorGold[] = [];
  for (const r of await readJsonl(citationLogPath)) {
    if (r["kind"] !== "tool_use") continue;
    const conv = typeof r["conversation_id"] === "string" ? r["conversation_id"] : "";
    const cited = typeof r["cited_id"] === "string" ? r["cited_id"] : "";
    if (!cited || ORPHAN.has(conv)) continue;
    gold.push({ conversationId: conv, citedId: cited });
  }

  const fires: FloorFire[] = [];
  for (const r of await readJsonl(hookLogPath)) {
    if (typeof r["kind"] === "string") continue;
    const ts = typeof r["ts"] === "string" ? Date.parse(r["ts"]) : 0;
    if (!ts || ts < cutoff) continue;
    const conv = typeof r["conversationId"] === "string" ? r["conversationId"] : "";
    if (ORPHAN.has(conv)) continue;
    const rawHits = Array.isArray(r["hits"]) ? r["hits"] : [];
    const hits = rawHits
      .map((h) => (h && typeof h === "object" ? (h as Record<string, unknown>) : null))
      .filter((h): h is Record<string, unknown> => h !== null && typeof h["id"] === "string")
      .map((h) => ({ id: h["id"] as string, score: typeof h["score"] === "number" ? h["score"] : 0 }));
    if (hits.length === 0) continue;
    if (Math.max(...hits.map((h) => h.score)) <= KEYWORD_RAW_SCALE_MIN) continue; // skip hybrid (0..1) fires
    fires.push({ conversationId: conv, hits });
  }

  const cal = calibrateFloor(fires, gold, minGold);
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

  console.log(`Score-floor calibration — last ${days}d (keyword/per-message path)`);
  console.log(`  gold (cited) hits: ${cal.goldHits} | noise (uncited-in-gold-conv) hits: ${cal.noiseHits}`);
  console.log("");
  console.log("  ABSOLUTE floor (raw BM25 — NOT portable across installs):");
  for (const p of cal.absolute) {
    console.log(`    raw >= ${String(p.threshold).padEnd(4)}  gold-kept ${pct(p.goldKept).padEnd(7)} noise-cut ${pct(p.noiseCut)}`);
  }
  console.log("");
  console.log("  MEDIAN-RELATIVE floor (score / fire-median — portable):");
  for (const p of cal.medianRelative) {
    console.log(`    rel >= ${p.threshold.toFixed(1)}  gold-kept ${pct(p.goldKept).padEnd(7)} noise-cut ${pct(p.noiseCut)}`);
  }
  console.log("");
  if (cal.recommended) {
    console.log(
      `  Recommended portable floor: rel >= ${cal.recommended.threshold.toFixed(1)} ` +
      `(keeps ${pct(cal.recommended.goldKept)} gold, cuts ${pct(cal.recommended.noiseCut)} noise, min-gold ${pct(minGold)})`,
    );
  } else {
    console.log(`  No median-relative floor keeps >= ${pct(minGold)} gold — floor not worth applying on this telemetry.`);
  }
}

if (!process.env["VITEST"]) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
