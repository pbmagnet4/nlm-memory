/**
 * T1782: the nightly relevance-precision metric.
 *
 * The recall hook injects session memories under a prompt and nothing has ever
 * measured whether the injected memory had anything to do with that prompt —
 * the retrieval score is chance-level for relevance (holdout AUC 0.59, see
 * docs/eval/T1782-relevance-judge.md). Clef judges (prompt, injected memory)
 * pairs at AUC 0.89, so one cheap Clef pass a night can answer the only
 * question that matters: **what share of what we injected was relevant?** That
 * share is `relevancePrecision`, reported under GET /api/health/slo as
 * `actual.relevancePrecision`.
 *
 * It is a **metric, never a gate.** On the eval holdout, holding 91% of the
 * genuinely relevant memories costs precision 0.59 and holding 95% costs 0.31,
 * so this number cannot both keep everything relevant and drop the noise — it
 * is a trend line, and nothing in the recall path reads it. It also reads
 * ~5 points low at the fitted threshold, which is why the threshold is a config
 * value (NLM_RELEVANCE_THRESHOLD) rather than a constant baked into a decision.
 *
 * Shape, per the eval: opt-in (NLM_RELEVANCE_JUDGE=on), a stride sample of the
 * last 24h of prompt-recall hook records, `wouldInject` ids expanded to the
 * session label + summary from the store, one Clef call per prompt with up to
 * RELEVANCE_CHUNK_DEFAULT memories (bigger slices hit HTTP 413), one `score`
 * question per memory, four ordered criteria, the `same` phrasing. Costs
 * minutes, not seconds — so it runs detached from the scheduler tick and never
 * inside a synchronous slice.
 *
 * Failure policy is fail-open by design: this is telemetry next to a recall
 * path that must stay served. Any Clef error (including a reply missing a
 * score) logs one WARN and skips the night, leaving the previous sample in
 * place — a half-scored night is a different distribution than a whole one, and
 * a metric that silently changes what it counts when the network is unhappy is
 * worse than a gap.
 *
 * Every night also dumps the pairs it scored to `<dataDir>/relevance/<date>.jsonl`
 * and keeps 14 of them. The eval's other honest caveat was that its gold labels
 * come from a model reading the same two fields, so before this number is quoted
 * as anything stronger than a trend, someone has to hand-check the pairs where
 * judge and label disagree — which needs the raw pairs, at the threshold and
 * model each night actually ran with, which is what those files are for.
 */
import { mkdirSync, renameSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { askClef, clefSettingsFromEnv, type ClefAnswer, type ClefQuestion, type ClefSettings } from "../../llm/clef-client.js";
import { hookLogPath, readTailText } from "@core/recall/hook-recall-log.js";
import { tenantStatePath } from "@core/tenancy/tenant-state-path.js";
import { DEFAULT_TEAM_ID } from "@core/tenancy/default-team.js";
import type { SloRelevanceSample } from "./slo-metrics.js";

export const RELEVANCE_WINDOW_MS = 24 * 60 * 60_000;
/** Sampled hook records per night. The eval's cost table puts ~60 prompts at a
 *  few minutes of flash serially; a hook day is a few hundred records. */
export const RELEVANCE_SAMPLE_DEFAULT = 60;
/** The `same`-phrasing threshold fitted on the eval's tune split, on flash at 8
 *  memories per call. Held fixed night to night so the number stays comparable —
 *  the eval's whole tune/holdout discipline rests on not re-fitting it.
 *
 *  It travels with the model and the chunk size, and neither is pinned here:
 *  NLM_CLEF_MODEL defaults to the base model, whose own fit is 1.47, and the
 *  scale moves measurably at 4 or 1 per call. So a deployment that changes
 *  either re-fits the threshold; what this default buys is comparability with
 *  the eval's own numbers, which is the point of a trend line's first nights. */
export const RELEVANCE_THRESHOLD_DEFAULT = 1.43;
export const RELEVANCE_PHRASING_DEFAULT = "same" as const;
/** Memories per Clef call. 29 memories x 3 questions came back HTTP 413 in the
 *  eval; 8 was the measured shape, and the absolute scale moves if this changes,
 *  which is why the threshold travels with it. */
export const RELEVANCE_CHUNK_DEFAULT = 8;
/** Summary chars per memory, matching the eval set's cap. */
const SUMMARY_CAP = 1200;
const LABEL_CAP = 200;
/** Hook-log bytes read from the end of the file. A record is a few hundred
 *  bytes, so this is several thousand records — far more than a day of traffic,
 *  and it keeps a huge history file from being slurped for a sample. */
const RELEVANCE_TAIL_BYTES = 8 * 1024 * 1024;
/** Ids per store read; `id IN (...)` stays well inside SQLite's parameter cap. */
const ID_BATCH = 50;

export type RelevancePhrasing = "same" | "dev" | "direct";

/** The three phrasings the eval rode in the same call; they correlate 0.95-0.99
 *  (the wording choice is nearly free) but the tune-fitted pick was `same`. */
const PHRASINGS: Record<RelevancePhrasing, string> = {
  same: "Is this memory about the same task or the same system as the prompt?",
  dev: "Would a developer handling this prompt want this memory open?",
  direct: "How relevant is this memory to the prompt?",
};

/** The 0-3 rubric the gold labels were made with, as the score legend. */
export const RELEVANCE_CRITERIA = [
  "Unrelated: a different task in a different system; nothing here bears on the prompt.",
  "Keyword overlap only: shares words, paths or tools, but a different task/system.",
  "Same system, related: the same project, tool or subsystem, work it could build on.",
  "Same task: directly about the task, decision, value or status the prompt is about.",
] as const;

export interface RelevanceSettings {
  readonly sample: number;
  readonly threshold: number;
  readonly phrasing: RelevancePhrasing;
  readonly chunk: number;
}

export function relevanceJudgeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["NLM_RELEVANCE_JUDGE"]?.trim() === "on";
}

/** NLM_RELEVANCE_SAMPLE / _THRESHOLD / _PHRASING / _CHUNK. Every invalid value
 *  falls back to the default (same discipline as diskThresholds): a typo must
 *  not turn the metric off, and must not silently change what the number means
 *  in a way nobody notices — the defaults ARE the measured configuration. */
export function relevanceSettings(env: NodeJS.ProcessEnv = process.env): RelevanceSettings {
  const sample = Number.parseInt(env["NLM_RELEVANCE_SAMPLE"] ?? "", 10);
  const threshold = Number.parseFloat(env["NLM_RELEVANCE_THRESHOLD"] ?? "");
  const chunk = Number.parseInt(env["NLM_RELEVANCE_CHUNK"] ?? "", 10);
  const phrasing = (env["NLM_RELEVANCE_PHRASING"] ?? "").trim() as RelevancePhrasing;
  return {
    sample: Number.isInteger(sample) && sample > 0 ? sample : RELEVANCE_SAMPLE_DEFAULT,
    // (0, 3]: 0 would keep every pair (the metric would read 100% forever), and
    // anything above the rubric's ceiling would keep none.
    threshold: Number.isFinite(threshold) && threshold > 0 && threshold <= 3 ? threshold : RELEVANCE_THRESHOLD_DEFAULT,
    phrasing: phrasing in PHRASINGS ? phrasing : RELEVANCE_PHRASING_DEFAULT,
    chunk: Number.isInteger(chunk) && chunk > 0 ? chunk : RELEVANCE_CHUNK_DEFAULT,
  };
}

// ── sampling (pure) ───────────────────────────────────────────────────

/** One prompt-recall fire, reduced to what the judge needs. */
export interface InjectionRecord {
  readonly ts: number;
  readonly conversationId: string;
  readonly promptPreview: string;
  readonly memoryIds: readonly string[];
}

/** Narrower than the SLO reader's `parseHookRecord`: the same kind-less recall
 *  fires, but only the ones where a recall actually returned hits (`ok`) and the
 *  prompt is present, since a timeout has no injections and a session-start
 *  fire has no prompt to judge relevance against. */
export function parseInjectionRecord(line: string): InjectionRecord | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (obj === null || typeof obj !== "object") return null;
  if (obj["kind"] !== undefined) return null;
  if (obj["recallOutcome"] !== "ok") return null;
  const ts = typeof obj["ts"] === "string" ? Date.parse(obj["ts"]) : Number.NaN;
  if (!Number.isFinite(ts)) return null;
  const preview = obj["promptPreview"];
  if (typeof preview !== "string" || !preview.trim()) return null;
  if (!Array.isArray(obj["wouldInject"])) return null;
  const memoryIds = (obj["wouldInject"] as unknown[]).filter((x): x is string => typeof x === "string");
  if (memoryIds.length === 0) return null;
  const conversationId = typeof obj["conversationId"] === "string" ? obj["conversationId"] : "unknown";
  return { ts, conversationId, promptPreview: preview, memoryIds };
}

/** Parse the tail text and take at most `sample` records from the last 24h.
 *  Even stride rather than "the newest N": a nightly that only ever looks at
 *  the last hour of traffic would trend with hourly traffic shape instead of
 *  the day's. Ties keep the oldest-first order, so the sample is deterministic
 *  for a fixed file. */
export function sampleRecords(
  text: string,
  opts: { readonly now: number; readonly sample: number },
): InjectionRecord[] {
  const cutoff = opts.now - RELEVANCE_WINDOW_MS;
  const eligible: InjectionRecord[] = [];
  for (const line of text.split("\n")) {
    const rec = parseInjectionRecord(line);
    if (rec && rec.ts >= cutoff) eligible.push(rec);
  }
  if (eligible.length <= opts.sample) return eligible;
  const stride = eligible.length / opts.sample;
  const picked: InjectionRecord[] = [];
  for (let i = 0; i < opts.sample; i += 1) picked.push(eligible[Math.floor(i * stride)]!);
  return picked;
}

// ── the judge call (pure shape, so the prompt is reviewable on its own) ──

export interface RelevanceMemory {
  readonly id: string;
  readonly label: string;
  readonly summary: string;
}

/** Question keys are positional: the reply is a map of answers and the ids only
 *  need to survive locally, in the same order as the memories. */
export function relevanceQuestionKey(i: number): string {
  return `m${i}`;
}

export function relevanceQuestions(
  memories: readonly RelevanceMemory[],
  phrasing: RelevancePhrasing,
): Record<string, ClefQuestion> {
  const questions: Record<string, ClefQuestion> = {};
  memories.forEach((m, i) => {
    questions[relevanceQuestionKey(i)] = {
      type: "score",
      instructions:
        `${PHRASINGS[phrasing]}\n\n`
        + `One of ${memories.length} memories injected under the prompt in state.\n`
        + `Label: ${m.label.slice(0, LABEL_CAP)}\n`
        + `Summary: ${m.summary.slice(0, SUMMARY_CAP)}\n\n`
        + "Score it 0-3 against the criteria.",
      criteria: [...RELEVANCE_CRITERIA],
    };
  });
  return questions;
}

/** One judged (prompt, memory) pair. */
export interface ScoredPair {
  readonly ts: number;
  readonly conversationId: string;
  readonly promptPreview: string;
  readonly memory: RelevanceMemory;
  readonly score: number;
  readonly kept: boolean;
}

export interface RelevanceAggregate {
  /** Kept share of the scored pairs, 0-1, rounded to 4 dp. */
  readonly value: number;
  readonly pairs: number;
  readonly kept: number;
}

/** Kept share = relevancePrecision. Null only when nothing was scored — a
 *  zero-pair night must read as "no measurement", not as 0% relevant. */
export function aggregateRelevance(
  pairs: readonly ScoredPair[],
): RelevanceAggregate | null {
  if (pairs.length === 0) return null;
  const kept = pairs.filter((p) => p.kept).length;
  return {
    value: Math.round((kept / pairs.length) * 10000) / 10000,
    pairs: pairs.length,
    kept,
  };
}

export interface RelevanceSessionReader {
  getByIds(
    tenantId: string,
    ids: ReadonlyArray<string>,
  ): Promise<ReadonlyArray<{ id: string; label: string | null; summary: string | null }>>;
}

/** Expand ids to label + summary in ID_BATCH-sized reads. Ids the store does
 *  not have (deleted, or superseded before the overlay resolved) are dropped —
 *  there is no text to judge, and inventing an empty-memory score would drag
 *  the metric down for a retention effect. */
export async function expandMemories(
  reader: RelevanceSessionReader,
  records: readonly InjectionRecord[],
  tenantId: string = DEFAULT_TEAM_ID,
): Promise<Map<string, RelevanceMemory>> {
  const ids = [...new Set(records.flatMap((r) => r.memoryIds))];
  const found = new Map<string, RelevanceMemory>();
  for (let i = 0; i < ids.length; i += ID_BATCH) {
    const batch = ids.slice(i, i + ID_BATCH);
    for (const s of await reader.getByIds(tenantId, batch)) {
      found.set(s.id, {
        id: s.id,
        label: s.label ?? "",
        summary: s.summary ?? "",
      });
    }
  }
  return found;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function scoreOf(answer: ClefAnswer | undefined): number | null {
  return answer?.type === "score" && Number.isFinite(answer.score) ? answer.score : null;
}

// ── the calibration dump ──────────────────────────────────────────

/** Nights of scored pairs to keep. The eval's closing recommendation is that
 *  this number has to be re-fitted against labels before anyone quotes it as a
 *  KPI, so the raw pairs are the point of the run's second output: two weeks of
 *  samples plus the volume a hand-check needs, at tens of kB a night. */
export const RELEVANCE_PAIRS_KEEP_DAYS = 14;

/** `<dataDir>/relevance` — the same state directory slo-metrics.json lives in. */
export function relevancePairsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env["NLM_RELEVANCE_DIR"] ?? tenantStatePath(DEFAULT_TEAM_ID, "relevance");
}

export function relevancePairsPath(dir: string, date: Date): string {
  return join(dir, `${date.toISOString().slice(0, 10)}.jsonl`);
}

/** One scored pair. The prompt preview and the memory label are what a human
 *  re-labels; `ts`/`conversationId` are how a line joins back to the hook log;
 *  `threshold`/`model` ride per line so a month of files can be re-scored at a
 *  new threshold without knowing what the job was configured with that night. */
function pairLine(p: ScoredPair, threshold: number, model: string): string {
  return JSON.stringify({
    ts: new Date(p.ts).toISOString(),
    conversationId: p.conversationId,
    promptPreview: p.promptPreview,
    memoryId: p.memory.id,
    memoryLabel: p.memory.label,
    score: p.score,
    kept: p.kept,
    threshold,
    model,
  });
}

/** Drop dated pair files older than the retention window. Named by date, so
 *  retention does not depend on mtime surviving a copy or a restore; anything
 *  in the directory that is not a dated pair file is left alone. */
export function prunePairs(dir: string, date: Date): void {
  const cutoff = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
    - (RELEVANCE_PAIRS_KEEP_DAYS - 1) * 24 * 60 * 60_000;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const dated = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
    if (!dated) continue;
    const day = Date.parse(`${dated[1]}T00:00:00.000Z`);
    if (!Number.isFinite(day) || day >= cutoff) continue;
    try {
      unlinkSync(join(dir, name));
    } catch {
      // Unlinkable today; next night tries again.
    }
  }
}

/**
 * Write the night's scored pairs to `<dir>/<UTC date>.jsonl`, then prune.
 * Whole-file atomic write rather than an append: the file *is* this night's
 * sample, so a same-date re-run replaces it instead of double-counting.
 * Returns the path, or null when the write failed — by then the metric is
 * already recorded, and a calibration dump never fails a night.
 */
export function writePairs(
  dir: string,
  date: Date,
  pairs: readonly ScoredPair[],
  threshold: number,
  model: string,
): string | null {
  const path = relevancePairsPath(dir, date);
  try {
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.pairs.${process.pid}.tmp`);
    writeFileSync(tmp, pairs.map((p) => pairLine(p, threshold, model)).join("\n") + "\n", "utf8");
    renameSync(tmp, path);
  } catch {
    return null;
  }
  prunePairs(dir, date);
  return path;
}

// ── one night's run ──────────────────────────────────────────────

export interface RelevanceNightlyDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => number;
  readonly logger?: (msg: string) => void;
  /** Store reader for label + summary. */
  readonly sessions: RelevanceSessionReader;
  readonly tenantId?: string;
  /** hook-log.jsonl to sample. Defaults to the shared resolution. */
  readonly hookLog?: string;
  /** Directory for the calibration pairs file. Default relevancePairsDir(). */
  readonly pairsDir?: string;
  /** Scored pairs go here (the SLO state). */
  readonly record: (sample: SloRelevanceSample) => void;
  readonly ask?: (
    state: unknown,
    questions: Record<string, ClefQuestion>,
    opts: ClefSettings,
  ) => Promise<{ answers: Record<string, ClefAnswer> }>;
}

export type RelevanceNightlyResult =
  | {
      readonly ran: true;
      readonly value: number;
      readonly pairs: number;
      readonly model: string;
      /** Where the calibration pairs went; null when that write failed. */
      readonly pairsPath: string | null;
    }
  | { readonly ran: false; readonly reason: "off" | "no-clef" | "no-records" | "no-pairs" | "clef-error"; readonly detail?: string };

/**
 * One night's measurement. Returns rather than throws for every failure mode:
 * the caller is a fire-and-forget timer next to a live recall path.
 */
export async function runRelevanceNightly(deps: RelevanceNightlyDeps): Promise<RelevanceNightlyResult> {
  const env = deps.env ?? process.env;
  if (!relevanceJudgeEnabled(env)) return { ran: false, reason: "off" };
  const now = deps.now ?? (() => Date.now());
  const log = deps.logger ?? ((m: string) => console.error(m));
  const settings = relevanceSettings(env);
  const clef = clefSettingsFromEnv(env);
  if (!clef) {
    log("[relevance] WARN NLM_RELEVANCE_JUDGE=on but NLM_CLEF_BASE_URL is unset; skipping the night");
    return { ran: false, reason: "no-clef" };
  }
  const ask = deps.ask ?? askClef;
  // The eval's p95 was 20 s at 8 memories/call and its max 26 s on a loaded
  // host; the client's 60 s default is generous without being unbounded.
  const opts: ClefSettings = { ...clef, timeoutMs: 60_000 };

  // The hook log's own tail reader, shared with hub damping: a capped seek, so
  // a busy month-old log costs the same as an empty one.
  const records = sampleRecords(readTailText(deps.hookLog ?? hookLogPath(deps.tenantId ?? DEFAULT_TEAM_ID), RELEVANCE_TAIL_BYTES), {
    now: now(),
    sample: settings.sample,
  });
  if (records.length === 0) return { ran: false, reason: "no-records" };

  const memories = await expandMemories(deps.sessions, records, deps.tenantId ?? DEFAULT_TEAM_ID);

  const warn = (why: string): RelevanceNightlyResult => {
    log(`[relevance] WARN ${why}; skipping the night (last sample stands)`);
    return { ran: false, reason: "clef-error", detail: why };
  };

  const pairs: ScoredPair[] = [];
  for (const rec of records) {
    const known = rec.memoryIds
      .map((id) => memories.get(id))
      .filter((m): m is RelevanceMemory => m !== undefined);
    if (known.length === 0) continue;
    for (const group of chunk(known, settings.chunk)) {
      let answers: Record<string, ClefAnswer>;
      try {
        ({ answers } = await ask({ prompt: rec.promptPreview }, relevanceQuestions(group, settings.phrasing), opts));
      } catch (e) {
        return warn(`Clef call failed (${e instanceof Error ? e.message : String(e)})`);
      }
      for (let i = 0; i < group.length; i += 1) {
        const score = scoreOf(answers[relevanceQuestionKey(i)]);
        if (score === null) return warn(`Clef reply had no score for ${relevanceQuestionKey(i)}`);
        pairs.push({
          ts: rec.ts,
          conversationId: rec.conversationId,
          promptPreview: rec.promptPreview,
          memory: group[i]!,
          score,
          kept: score >= settings.threshold,
        });
      }
    }
  }

  const agg = aggregateRelevance(pairs);
  if (!agg) return { ran: false, reason: "no-pairs" };
  const sample: SloRelevanceSample = {
    at: now(),
    value: agg.value,
    pairs: agg.pairs,
    threshold: settings.threshold,
    model: clef.model,
    phrasing: settings.phrasing,
  };
  deps.record(sample);
  // The metric is recorded first: the calibration dump is worth having, and is
  // not worth losing a night over.
  const pairsPath = writePairs(
    deps.pairsDir ?? relevancePairsDir(deps.env),
    new Date(sample.at),
    pairs,
    settings.threshold,
    clef.model,
  );
  if (pairsPath === null) log("[relevance] WARN could not write the calibration pairs; the metric still stands");
  return { ran: true, value: agg.value, pairs: agg.pairs, model: clef.model, pairsPath };
}

// ── where the job keeps its state ───────────────────────────────────

/** Last-attempt marker, read and written by the scheduler's nightly gate. It
 *  records the *attempt*, not the success, so a night that fails against an
 *  offline inference host costs one WARN a day rather than a retry every
 *  scheduler tick. NLM_RELEVANCE_STATE overrides the path (tests); otherwise
 *  the default team's state dir, next to slo-metrics.json. */
export function relevanceStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return env["NLM_RELEVANCE_STATE"] ?? tenantStatePath(DEFAULT_TEAM_ID, "relevance-nightly.json");
}
