/**
 * Pure helpers for the recall-impact replay eval (docs/superpowers/specs/
 * 2026-07-21-recall-impact-replay-eval-design.md). No I/O — sampling,
 * stratification, exclusions, order randomization, and the pre-registered
 * PASS/NULL/HARM gate math all live here so they can be fixture-tested in
 * isolation from the network/DB-touching orchestration script.
 *
 * The gate thresholds are pre-registered and must not move after the run —
 * see GATE_THRESHOLDS.
 */

import { formatPointerBlock, type PointerHit } from "../../../src/core/hook/pointer-block.js";

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32) — deterministic given a numeric seed. Used for both
// stratified-sample shuffling and (via a distinct derived seed) per-pair
// judge-order randomization, so a full run is byte-for-byte reproducible.
// ---------------------------------------------------------------------------

export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return function rng(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a string hash → uint32. Used to derive independent sub-seeds from a base seed + label, so different concerns (sampling vs. judge-order) never share PRNG state. */
export function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function deriveSeed(seed: number, label: string): number {
  return fnv1a(`${seed}:${label}`);
}

export function seededShuffle<T>(arr: ReadonlyArray<T>, rng: () => number): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

export interface HookLogRow {
  readonly ts: string;
  readonly promptPreview: string;
  readonly wouldInject: ReadonlyArray<string>;
}

/** A session id → session-fields lookup, minimal shape needed to rebuild a pointer block. Decoupled from the full core `Session` type on purpose. */
export interface SessionLike {
  readonly id: string;
  readonly label: string;
  readonly startedAt: string;
  readonly summary: string;
}

/**
 * Rebuilds arm A's pointer block from a row's `wouldInject` session ids,
 * using the hook's real composer (formatPointerBlock) verbatim. Returns null
 * if any referenced session id is not present in `sessionMap` (unresolved —
 * the session was deleted/never ingested since the hook fired).
 *
 * Facts/exemplars are not reconstructable: the hook log only ever records
 * session ids in `wouldInject` (facts/exemplars are rendered into the live
 * block but never logged), so every reconstructed block here is session-
 * pointer-only. This is a known, reported limitation — see the "facts vs
 * session-pointer" bucket in the report, which is always 0 facts.
 */
export function reconstructBlock(
  wouldInject: ReadonlyArray<string>,
  sessionMap: ReadonlyMap<string, SessionLike>,
): string | null {
  const hits: PointerHit[] = [];
  for (const id of wouldInject) {
    const s = sessionMap.get(id);
    if (!s) return null;
    hits.push({ id: s.id, label: s.label, startedAt: s.startedAt, summary: s.summary });
  }
  return formatPointerBlock(hits);
}

export function monthKey(ts: string): string {
  return ts.slice(0, 7);
}

// ---------------------------------------------------------------------------
// Exclusions (pre-registered, applied before sampling)
// ---------------------------------------------------------------------------

const LEAKAGE_MIN_LINE_LENGTH = 20;

/** True if the prompt already contains a verbatim line (>=20 chars) of its own reconstructed pointer block — evidence the operator pasted prior hook output into the prompt. */
export function hasLeakage(promptPreview: string, blockText: string): boolean {
  if (!blockText) return false;
  return blockText
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length >= LEAKAGE_MIN_LINE_LENGTH)
    .some((line) => promptPreview.includes(line));
}

export interface ResolvedRow extends HookLogRow {
  /** Reconstructed arm-A block, or null if a referenced session id didn't resolve. */
  readonly blockText: string | null;
}

export interface EligibleRow extends HookLogRow {
  readonly blockText: string;
  readonly month: string;
}

export interface ExclusionCounts {
  readonly tooShort: number;
  readonly duplicate: number;
  readonly unresolved: number;
  readonly leakage: number;
}

export interface FilterResult {
  readonly eligible: ReadonlyArray<EligibleRow>;
  readonly excluded: ExclusionCounts;
}

/**
 * Applies the three pre-registered exclusions in a fixed priority order —
 * too_short, duplicate (text-only, cheap), then unresolved, then leakage
 * (both need the reconstructed block) — so every excluded row lands in
 * exactly one bucket. Rows must already be in chronological (file) order;
 * "duplicate" keeps the first occurrence of a given trimmed prompt text,
 * whether or not that first occurrence itself survives later filters.
 */
export function filterEligible(rows: ReadonlyArray<ResolvedRow>, minChars = 15): FilterResult {
  let tooShort = 0;
  let duplicate = 0;
  let unresolved = 0;
  let leakage = 0;
  const seen = new Set<string>();
  const eligible: EligibleRow[] = [];

  for (const row of rows) {
    const trimmed = row.promptPreview.trim();
    if (trimmed.length < minChars) {
      tooShort++;
      continue;
    }
    if (seen.has(trimmed)) {
      duplicate++;
      continue;
    }
    seen.add(trimmed);
    if (row.blockText === null) {
      unresolved++;
      continue;
    }
    if (hasLeakage(row.promptPreview, row.blockText)) {
      leakage++;
      continue;
    }
    eligible.push({
      ts: row.ts,
      promptPreview: row.promptPreview,
      wouldInject: row.wouldInject,
      blockText: row.blockText,
      month: monthKey(row.ts),
    });
  }

  return { eligible, excluded: { tooShort, duplicate, unresolved, leakage } };
}

// ---------------------------------------------------------------------------
// Stratified sampling (by month, proportional allocation, largest remainder)
// ---------------------------------------------------------------------------

export interface StratifiedSampleResult<T> {
  readonly selected: ReadonlyArray<T>;
  readonly strataCounts: Readonly<Record<string, number>>;
}

/**
 * Samples n rows from `rows`, allocated across `keyOf` strata proportional to
 * each stratum's share of the pool (largest-remainder rounding to hit n
 * exactly), then a seeded shuffle within each stratum. Deterministic given
 * the same `rows` order + seed — callers must pass rows in a stable order
 * (the hook log's natural chronological order).
 */
export function stratifiedSample<T>(
  rows: ReadonlyArray<T>,
  keyOf: (row: T) => string,
  n: number,
  seed: number,
): StratifiedSampleResult<T> {
  const total = rows.length;
  const target = Math.max(0, Math.min(n, total));
  if (target === 0) return { selected: [], strataCounts: {} };

  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const k = keyOf(row);
    const list = groups.get(k);
    if (list) list.push(row);
    else groups.set(k, [row]);
  }

  const keys = [...groups.keys()].sort();
  const alloc = new Map<string, { size: number; base: number; frac: number }>();
  let allocated = 0;
  for (const k of keys) {
    const size = groups.get(k)!.length;
    const exact = target * (size / total);
    const base = Math.floor(exact);
    alloc.set(k, { size, base, frac: exact - base });
    allocated += base;
  }

  let remaining = target - allocated;
  const byFrac = keys
    .slice()
    .sort((a, b) => alloc.get(b)!.frac - alloc.get(a)!.frac || a.localeCompare(b));

  // First pass: hand out remainder by largest fractional share, capped at stratum size.
  for (const k of byFrac) {
    if (remaining <= 0) break;
    const entry = alloc.get(k)!;
    if (entry.base < entry.size) {
      entry.base++;
      remaining--;
    }
  }
  // Second pass: some strata may have been capped in pass one (small strata,
  // large fractional share) — sweep round-robin over any stratum with
  // remaining headroom until the target is hit or no stratum has room left.
  let guard = 0;
  while (remaining > 0 && guard < 10_000) {
    guard++;
    let progressed = false;
    for (const k of byFrac) {
      if (remaining <= 0) break;
      const entry = alloc.get(k)!;
      if (entry.base < entry.size) {
        entry.base++;
        remaining--;
        progressed = true;
      }
    }
    if (!progressed) break;
  }

  const rng = makeRng(seed);
  const selected: T[] = [];
  const strataCounts: Record<string, number> = {};
  for (const k of keys) {
    const entry = alloc.get(k)!;
    strataCounts[k] = entry.base;
    const shuffled = seededShuffle(groups.get(k)!, rng);
    selected.push(...shuffled.slice(0, entry.base));
  }

  return { selected, strataCounts };
}

// ---------------------------------------------------------------------------
// Judge-order randomization (per pair, derived from the fixed seed)
// ---------------------------------------------------------------------------

export type ArmLabel = "A" | "B";

export interface PairOrder {
  readonly x: ArmLabel;
  readonly y: ArmLabel;
}

/**
 * Deterministic per-pair X/Y assignment, derived from (seed, pairKey) only —
 * independent of processing order, so re-running the same pair in isolation
 * reproduces the same order. pairKey should uniquely identify the sampled
 * pair (e.g. the hook-log row's ts).
 */
export function orderForPair(seed: number, pairKey: string): PairOrder {
  const rng = makeRng(deriveSeed(seed, `order:${pairKey}`));
  return rng() < 0.5 ? { x: "A", y: "B" } : { x: "B", y: "A" };
}

export type JudgeWinner = "X" | "Y" | "tie";

/** Maps the judge's blind X/Y verdict back to the arm it actually favored. */
export function resolveArmWinner(order: PairOrder, winner: JudgeWinner): ArmLabel | "tie" {
  if (winner === "tie") return "tie";
  return winner === "X" ? order.x : order.y;
}

// ---------------------------------------------------------------------------
// Judge verdict parsing (strict JSON, tolerant of code fences / stray prose)
// ---------------------------------------------------------------------------

export interface JudgeVerdictRaw {
  readonly winner: JudgeWinner;
  readonly reason: string;
}

const FENCE_RE = /^```(?:json)?\s*|\s*```$/gm;

/** Parses a judge reply into a strict verdict object. Returns null (never throws) on any malformed shape — callers retry once, then count as tie. */
export function parseJudgeVerdict(raw: string): JudgeVerdictRaw | null {
  const stripped = raw.replace(FENCE_RE, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    const start = stripped.indexOf("{");
    const end = stripped.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      parsed = JSON.parse(stripped.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const winner = obj["winner"];
  if (winner !== "X" && winner !== "Y" && winner !== "tie") return null;
  const reason = typeof obj["reason"] === "string" ? obj["reason"] : "";
  return { winner, reason };
}

// ---------------------------------------------------------------------------
// Prompt composition (pure — no arm identity ever reaches the judge prompt)
// ---------------------------------------------------------------------------

export interface ChatMessages {
  readonly system: string;
  readonly user: string;
}

/** Arm A prepends the reconstructed pointer block; arm B (blockText = null) is the bare prompt. Same system message both arms. */
export function buildGeneratorMessages(promptText: string, blockText: string | null): ChatMessages {
  const system =
    "You are a helpful AI assistant responding to the user's message. Respond directly and specifically to their situation.";
  const user = blockText ? `${blockText}\n\n${promptText}` : promptText;
  return { system, user };
}

/** Blind judge prompt: sees the user prompt + labeled X/Y responses only, never arm identity or the injected block. */
export function buildJudgePrompt(userPrompt: string, responseX: string, responseY: string): ChatMessages {
  const system = [
    "You are a blind evaluator comparing two AI assistant responses to the same user prompt.",
    "Judge strictly on: (a) specificity to the user's actual situation and history, (b) absence of generic filler, (c) actionability.",
    "You are not told anything about how either response was produced. Judge only the text on the page.",
    'Reply with ONLY a JSON object: {"winner": "X" | "Y" | "tie", "reason": "<one sentence>"}. No markdown fences, no extra text.',
  ].join("\n");
  const user = [
    `User prompt:\n${userPrompt}`,
    "",
    `Response X:\n${responseX}`,
    "",
    `Response Y:\n${responseY}`,
  ].join("\n");
  return { system, user };
}

// ---------------------------------------------------------------------------
// Quartile bucketing (secondary, reported not gating)
// ---------------------------------------------------------------------------

/** Linear-interpolated quartile cut points (Q1, Q2, Q3) over `values`. */
export function computeQuartiles(values: ReadonlyArray<number>): readonly [number, number, number] {
  if (values.length === 0) return [0, 0, 0];
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number): number => {
    const idx = p * (sorted.length - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    const loVal = sorted[lo]!;
    if (lo === hi) return loVal;
    const hiVal = sorted[hi]!;
    return loVal * (1 - (idx - lo)) + hiVal * (idx - lo);
  };
  return [at(0.25), at(0.5), at(0.75)];
}

/** Which quartile (0=Q1 .. 3=Q4) `value` falls into, given cut points from computeQuartiles. */
export function bucketIndex(value: number, quartiles: readonly [number, number, number]): 0 | 1 | 2 | 3 {
  const [q1, q2, q3] = quartiles;
  if (value <= q1) return 0;
  if (value <= q2) return 1;
  if (value <= q3) return 2;
  return 3;
}

// ---------------------------------------------------------------------------
// Pre-registered PASS/NULL/HARM gate — thresholds cannot move after the run.
// ---------------------------------------------------------------------------

export const GATE_THRESHOLDS = {
  winRatePass: 0.6,
  decisiveRatePass: 0.3,
  harmShare: 0.4,
} as const;

export interface JudgedPairOutcome {
  readonly winner: ArmLabel | "tie";
}

export interface VerdictResult {
  readonly n: number;
  readonly decisive: number;
  readonly armAWins: number;
  readonly armBWins: number;
  readonly decisiveRate: number;
  /** Arm A's win rate among decisive pairs. 0 when there are no decisive pairs (decisiveRate will already be 0, failing the bar). */
  readonly winRate: number;
  /** Arm B's win share among decisive pairs — the HARM check. */
  readonly armBShare: number;
  readonly harm: boolean;
  readonly verdict: "PASS" | "NULL";
}

export function computeVerdict(outcomes: ReadonlyArray<JudgedPairOutcome>): VerdictResult {
  const n = outcomes.length;
  const armAWins = outcomes.filter((o) => o.winner === "A").length;
  const armBWins = outcomes.filter((o) => o.winner === "B").length;
  const decisive = armAWins + armBWins;
  const decisiveRate = n > 0 ? decisive / n : 0;
  const winRate = decisive > 0 ? armAWins / decisive : 0;
  const armBShare = decisive > 0 ? armBWins / decisive : 0;
  const harm = armBShare > GATE_THRESHOLDS.harmShare;
  const verdict: "PASS" | "NULL" =
    !harm && winRate >= GATE_THRESHOLDS.winRatePass && decisiveRate >= GATE_THRESHOLDS.decisiveRatePass
      ? "PASS"
      : "NULL";
  return { n, decisive, armAWins, armBWins, decisiveRate, winRate, armBShare, harm, verdict };
}
