/**
 * Recall-impact replay eval — pre-registered design. Read-only against the
 * live corpus; writes nothing but its own report/state files.
 *
 * Spec (binding): docs/superpowers/specs/2026-07-21-recall-impact-replay-eval-design.md
 *
 * Question: does the pointer-block context nlm-memory injects causally
 * improve the agent's response, on the operator's real workload? Replays
 * `~/.nlm/hook-log.jsonl` rows: arm A = prompt + the reconstructed pointer
 * block (via the hook's real formatPointerBlock composer), arm B = the bare
 * prompt. One fixed generator model produces both, sequentially; a different-
 * family judge model picks a blind winner (X/Y order randomized per pair,
 * never told which arm is which or shown the injected block itself).
 *
 * Usage:
 *   NLM_EVAL_GEN_BASE_URL=http://host:port/v1 NLM_EVAL_GEN_MODEL=... \
 *   NLM_EVAL_JUDGE_BASE_URL=http://host:port/v1 NLM_EVAL_JUDGE_MODEL=... \
 *   npx tsx scripts/eval/recall-impact-replay.ts [--pilot] [--report-dir <path>] [--budget-s <n>]
 *
 * --pilot runs n=10 (seed 99) as a mechanics-only smoke test, clearly labeled
 * PILOT in the report and excluded from any PASS/NULL/HARM verdict. The full
 * run is n=100 (seed 20260721, the pre-registered seed) and includes a
 * 20-pair double-judge consistency subsample.
 *
 * Checkpointing: state is persisted to <report-dir>/state-<mode>-<seed>.json
 * after every model call, and --budget-s makes the process exit cleanly once
 * the wall budget is spent. Re-running the same command resumes where it left
 * off. This is load-bearing, not a convenience: on the shared local server a
 * full run is hours long and the harness must survive being driven in
 * bounded foreground invocations. Sampling is seed-deterministic, but resume
 * loads the sampled pairs from state verbatim so a corpus that changed
 * between invocations cannot silently alter the sample mid-run.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteSessionStore } from "../../src/core/storage/sqlite-session-store.js";
import {
  bucketIndex,
  buildGeneratorMessages,
  buildJudgePrompt,
  computeQuartiles,
  computeVerdict,
  deriveSeed,
  filterEligible,
  GATE_THRESHOLDS,
  makeRng,
  orderForPair,
  parseJudgeVerdict,
  reconstructBlock,
  resolveArmWinner,
  seededShuffle,
  stratifiedSample,
  type ArmLabel,
  type ExclusionCounts,
  type HookLogRow,
  type JudgedPairOutcome,
  type ResolvedRow,
  type SessionLike,
} from "./lib/recall-impact-replay-lib.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");
const CHAT_TIMEOUT_MS = 240_000;
const GEN_TEMPERATURE = 0.1;
const GEN_MAX_TOKENS = 1024;
const JUDGE_MAX_TOKENS = 300;
const DOUBLE_JUDGE_N = 20;
// Optional passthrough for servers that serve reasoning models: without it,
// reasoning_content silently consumes the max_tokens budget and content comes
// back empty (measured in the pilot: 50% generation failures, 100% judge
// failures on LM Studio thinking-mode models). Set to e.g. "none" to disable
// thinking. Omitted from the request when unset; recorded in the report.
const REASONING_EFFORT = process.env["NLM_EVAL_REASONING_EFFORT"];

interface Mode {
  readonly label: "PILOT" | "FULL";
  readonly n: number;
  readonly seed: number;
  readonly doubleJudge: boolean;
}

function resolveMode(argv: ReadonlyArray<string>): Mode {
  if (argv.includes("--pilot")) return { label: "PILOT", n: 10, seed: 99, doubleJudge: false };
  return { label: "FULL", n: 100, seed: 20260721, doubleJudge: true };
}

function resolveReportDir(argv: ReadonlyArray<string>): string {
  const idx = argv.indexOf("--report-dir");
  if (idx >= 0 && argv[idx + 1]) return resolve(argv[idx + 1]!);
  return join(homedir(), ".nlm", "eval-replay");
}

function resolveBudgetMs(argv: ReadonlyArray<string>): number {
  const idx = argv.indexOf("--budget-s");
  if (idx < 0 || !argv[idx + 1]) return 0;
  const n = Number(argv[idx + 1]);
  return Number.isFinite(n) && n > 0 ? n * 1000 : 0;
}

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

interface ChatConfig {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string;
}

function genConfig(): ChatConfig {
  return {
    baseUrl: requiredEnv("NLM_EVAL_GEN_BASE_URL"),
    model: requiredEnv("NLM_EVAL_GEN_MODEL"),
    apiKey: process.env["NLM_EVAL_GEN_API_KEY"] ?? "lm-studio",
  };
}

function judgeConfig(): ChatConfig {
  return {
    baseUrl: requiredEnv("NLM_EVAL_JUDGE_BASE_URL"),
    model: requiredEnv("NLM_EVAL_JUDGE_MODEL"),
    apiKey: process.env["NLM_EVAL_JUDGE_API_KEY"] ?? "lm-studio",
  };
}

// ---------------------------------------------------------------------------
// Hook log ingest
// ---------------------------------------------------------------------------

function hookLogPath(): string {
  return process.env["NLM_HOOK_LOG"] ?? join(homedir(), ".nlm", "hook-log.jsonl");
}

interface RawHookLogLine {
  readonly ts?: unknown;
  readonly promptPreview?: unknown;
  readonly gate?: unknown;
  readonly wouldInject?: unknown;
}

/** Reads gate=evaluate rows with a non-empty wouldInject, tolerating malformed lines (counted, not thrown). */
function readEligibleGateRows(path: string): { rows: HookLogRow[]; malformedLines: number } {
  const raw = readFileSync(path, "utf8");
  const rows: HookLogRow[] = [];
  let malformedLines = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let parsed: RawHookLogLine;
    try {
      parsed = JSON.parse(line) as RawHookLogLine;
    } catch {
      malformedLines++;
      continue;
    }
    if (parsed.gate !== "evaluate") continue;
    const wouldInject = Array.isArray(parsed.wouldInject) ? (parsed.wouldInject as string[]) : [];
    if (wouldInject.length === 0) continue;
    if (typeof parsed.ts !== "string" || typeof parsed.promptPreview !== "string") continue;
    rows.push({ ts: parsed.ts, promptPreview: parsed.promptPreview, wouldInject });
  }
  return { rows, malformedLines };
}

// ---------------------------------------------------------------------------
// Chat completion (OpenAI-compatible, non-streaming — one retry on failure)
// ---------------------------------------------------------------------------

async function callChatOnce(
  cfg: ChatConfig,
  system: string,
  user: string,
  params: { temperature: number; maxTokens: number },
  timeoutMs: number,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: params.temperature,
        max_tokens: params.maxTokens,
        stream: false,
        ...(REASONING_EFFORT ? { reasoning_effort: REASONING_EFFORT } : {}),
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
    }
    const body = (await res.json()) as { choices?: ReadonlyArray<{ message?: { content?: string } }> };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim().length === 0) {
      // Reasoning models can burn the whole max_tokens budget on
      // reasoning_content and return an empty content string — surfaced as a
      // failure (one retry upstream) and reported, never silently accepted.
      throw new Error("empty completion");
    }
    return content;
  } finally {
    clearTimeout(timer);
  }
}

/** One retry on any transport/HTTP failure — matches the shared-server queuing note in the spec. */
async function callChat(
  cfg: ChatConfig,
  system: string,
  user: string,
  params: { temperature: number; maxTokens: number },
): Promise<string> {
  try {
    return await callChatOnce(cfg, system, user, params, CHAT_TIMEOUT_MS);
  } catch {
    return await callChatOnce(cfg, system, user, params, CHAT_TIMEOUT_MS);
  }
}

// ---------------------------------------------------------------------------
// State (checkpoint/resume)
// ---------------------------------------------------------------------------

interface PairRecord {
  readonly ts: string;
  readonly month: string;
  readonly promptPreview: string;
  readonly wouldInject: ReadonlyArray<string>;
  readonly blockText: string;
  readonly blockTokens: number;
  responseA: string | null;
  responseB: string | null;
  genFailed: boolean;
  order: { x: ArmLabel; y: ArmLabel } | null;
  judgeMalformedFinal: boolean;
  winner: ArmLabel | "tie" | null;
  judgeFailed: boolean;
  doubleJudged: boolean;
  doubleJudgeWinner: ArmLabel | "tie" | null;
}

interface EvalState {
  readonly mode: "PILOT" | "FULL";
  readonly seed: number;
  readonly exclusions: ExclusionCounts;
  readonly strataCounts: Readonly<Record<string, number>>;
  readonly hookLogMalformedLines: number;
  readonly referencedIds: number;
  readonly resolvedIds: number;
  readonly pairs: PairRecord[];
  genMs: number;
  judgeMs: number;
}

function statePath(reportDir: string, mode: Mode): string {
  return join(reportDir, `state-${mode.label.toLowerCase()}-${mode.seed}.json`);
}

function saveState(path: string, state: EvalState): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state), "utf8");
  renameSync(tmp, path);
}

async function initState(mode: Mode): Promise<EvalState> {
  const { rows, malformedLines } = readEligibleGateRows(hookLogPath());
  console.log(`hook log: ${rows.length} eligible rows (gate=evaluate, non-empty wouldInject), ${malformedLines} malformed lines skipped`);

  const dbPath = process.env["NLM_DB_PATH"] ?? resolve(homedir(), ".nlm/canonical.sqlite");
  if (!existsSync(dbPath)) throw new Error(`corpus DB not found at ${dbPath}`);
  const store = new SqliteSessionStore({ dbPath, migrationsDir: MIGRATIONS_DIR, readonly: true });
  const uniqueIds = [...new Set(rows.flatMap((r) => r.wouldInject))];
  const sessions = await store.getByIds(uniqueIds);
  store.close();
  const sessionMap = new Map<string, SessionLike>(
    sessions.map((s) => [s.id, { id: s.id, label: s.label, startedAt: s.startedAt, summary: s.summary }]),
  );
  console.log(`corpus: ${uniqueIds.length} unique referenced session ids, ${sessionMap.size} resolved`);

  const resolvedRows: ResolvedRow[] = rows.map((r) => ({
    ...r,
    blockText: reconstructBlock(r.wouldInject, sessionMap),
  }));
  const { eligible, excluded } = filterEligible(resolvedRows);
  console.log(
    `eligible pool: ${eligible.length} (excluded: tooShort=${excluded.tooShort} duplicate=${excluded.duplicate} unresolved=${excluded.unresolved} leakage=${excluded.leakage})`,
  );

  const { selected, strataCounts } = stratifiedSample(eligible, (r) => r.month, mode.n, mode.seed);
  console.log(`sampled ${selected.length} pairs; strata=${JSON.stringify(strataCounts)}`);

  return {
    mode: mode.label,
    seed: mode.seed,
    exclusions: excluded,
    strataCounts,
    hookLogMalformedLines: malformedLines,
    referencedIds: uniqueIds.length,
    resolvedIds: sessionMap.size,
    pairs: selected.map((r) => ({
      ts: r.ts,
      month: r.month,
      promptPreview: r.promptPreview,
      wouldInject: r.wouldInject,
      blockText: r.blockText,
      blockTokens: Math.ceil(r.blockText.length / 4),
      responseA: null,
      responseB: null,
      genFailed: false,
      order: null,
      judgeMalformedFinal: false,
      winner: null,
      judgeFailed: false,
      doubleJudged: false,
      doubleJudgeWinner: null,
    })),
    genMs: 0,
    judgeMs: 0,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const mode = resolveMode(argv);
  const reportDir = resolveReportDir(argv);
  const budgetMs = resolveBudgetMs(argv);
  mkdirSync(reportDir, { recursive: true });

  const gen = genConfig();
  const judge = judgeConfig();
  const runStart = Date.now();
  const budgetSpent = (): boolean => budgetMs > 0 && Date.now() - runStart >= budgetMs;

  console.log(`[${mode.label}] n=${mode.n} seed=${mode.seed} gen=${gen.model} judge=${judge.model}${budgetMs > 0 ? ` budget=${budgetMs / 1000}s` : ""}`);

  const spath = statePath(reportDir, mode);
  let state: EvalState;
  if (existsSync(spath)) {
    state = JSON.parse(readFileSync(spath, "utf8")) as EvalState;
    const done = state.pairs.filter((p) => p.winner !== null || p.genFailed || p.judgeFailed).length;
    console.log(`resuming from ${spath}: ${done}/${state.pairs.length} pairs already settled`);
  } else {
    state = await initState(mode);
    saveState(spath, state);
  }
  const pairs = state.pairs;

  // --- Generate (sequential, arm A then arm B per pair) ---
  for (const [i, pair] of pairs.entries()) {
    if (pair.genFailed || (pair.responseA !== null && pair.responseB !== null)) continue;
    if (budgetSpent()) return exitCheckpoint(spath, state, "generation");
    const armA = buildGeneratorMessages(pair.promptPreview, pair.blockText);
    const armB = buildGeneratorMessages(pair.promptPreview, null);
    const started = Date.now();
    try {
      if (pair.responseA === null) {
        pair.responseA = await callChat(gen, armA.system, armA.user, { temperature: GEN_TEMPERATURE, maxTokens: GEN_MAX_TOKENS });
        state.genMs += Date.now() - started;
        saveState(spath, state);
      }
      const startedB = Date.now();
      pair.responseB = await callChat(gen, armB.system, armB.user, { temperature: GEN_TEMPERATURE, maxTokens: GEN_MAX_TOKENS });
      state.genMs += Date.now() - startedB;
    } catch (e) {
      pair.genFailed = true;
      state.genMs += Date.now() - started;
      console.warn(`generation failed for pair ${i} (${pair.ts}): ${(e as Error).message}`);
    }
    saveState(spath, state);
  }
  const genFailures = pairs.filter((p) => p.genFailed).length;
  console.log(`generation done: ${pairs.length - genFailures}/${pairs.length} succeeded, ${(state.genMs / 1000).toFixed(0)}s cumulative`);

  // --- Judge (sequential, blind, order randomized per pair) ---
  for (const pair of pairs) {
    if (pair.genFailed || pair.responseA === null || pair.responseB === null) continue;
    if (pair.winner !== null || pair.judgeFailed) continue;
    if (budgetSpent()) return exitCheckpoint(spath, state, "judging");
    const order = orderForPair(mode.seed, pair.ts);
    pair.order = order;
    const responseX = order.x === "A" ? pair.responseA : pair.responseB;
    const responseY = order.y === "A" ? pair.responseA : pair.responseB;
    const { system, user } = buildJudgePrompt(pair.promptPreview, responseX, responseY);
    const started = Date.now();
    try {
      let verdict = parseJudgeVerdict(await callChat(judge, system, user, { temperature: 0, maxTokens: JUDGE_MAX_TOKENS }));
      if (!verdict) {
        verdict = parseJudgeVerdict(await callChat(judge, system, user, { temperature: 0, maxTokens: JUDGE_MAX_TOKENS }));
      }
      if (!verdict) {
        pair.judgeMalformedFinal = true;
        pair.winner = "tie";
      } else {
        pair.winner = resolveArmWinner(order, verdict.winner);
      }
    } catch (e) {
      pair.judgeFailed = true;
      console.warn(`judge failed for pair ${pair.ts}: ${(e as Error).message}`);
    }
    state.judgeMs += Date.now() - started;
    saveState(spath, state);
  }
  const judgeFailures = pairs.filter((p) => p.judgeFailed).length;
  const malformedTotal = pairs.filter((p) => p.judgeMalformedFinal).length;
  console.log(`judging done: ${(state.judgeMs / 1000).toFixed(0)}s cumulative, malformed=${malformedTotal}, judgeFailures=${judgeFailures}`);

  // --- Double-judge consistency subsample (full run only) ---
  if (mode.doubleJudge) {
    const judged = pairs.filter((p) => p.winner !== null && p.order !== null);
    const subsampleSeed = deriveSeed(mode.seed, "double-judge");
    const subsample = seededShuffle(judged, makeRng(subsampleSeed)).slice(0, DOUBLE_JUDGE_N);
    for (const pair of subsample) {
      if (pair.doubleJudged) continue;
      if (budgetSpent()) return exitCheckpoint(spath, state, "double-judge");
      const order = pair.order!;
      const responseX = order.x === "A" ? pair.responseA! : pair.responseB!;
      const responseY = order.y === "A" ? pair.responseA! : pair.responseB!;
      const { system, user } = buildJudgePrompt(pair.promptPreview, responseX, responseY);
      const started = Date.now();
      try {
        const verdict = parseJudgeVerdict(await callChat(judge, system, user, { temperature: 0, maxTokens: JUDGE_MAX_TOKENS }));
        pair.doubleJudgeWinner = verdict ? resolveArmWinner(order, verdict.winner) : "tie";
        pair.doubleJudged = true;
      } catch (e) {
        console.warn(`double-judge failed for pair ${pair.ts}: ${(e as Error).message}`);
      }
      state.judgeMs += Date.now() - started;
      saveState(spath, state);
    }
  }

  // --- Metrics ---
  const outcomes: JudgedPairOutcome[] = pairs
    .filter((p) => p.winner !== null)
    .map((p) => ({ winner: p.winner! }));
  const verdictResult = computeVerdict(outcomes);

  const tokenValues = pairs.map((p) => p.blockTokens);
  const quartiles = computeQuartiles(tokenValues);
  const bucketOutcomes = new Map<0 | 1 | 2 | 3, JudgedPairOutcome[]>();
  for (const pair of pairs) {
    if (pair.winner === null) continue;
    const b = bucketIndex(pair.blockTokens, quartiles);
    const list = bucketOutcomes.get(b);
    if (list) list.push({ winner: pair.winner });
    else bucketOutcomes.set(b, [{ winner: pair.winner }]);
  }
  const tokenBuckets = [0, 1, 2, 3].map((b) => {
    const list = bucketOutcomes.get(b as 0 | 1 | 2 | 3) ?? [];
    const v = computeVerdict(list);
    return { quartile: b + 1, n: list.length, winRate: v.winRate, decisiveRate: v.decisiveRate };
  });

  const doubleJudgedPairs = pairs.filter((p) => p.doubleJudged);
  const doubleJudge = mode.doubleJudge
    ? {
        n: doubleJudgedPairs.length,
        agree: doubleJudgedPairs.filter((p) => p.doubleJudgeWinner === p.winner).length,
      }
    : null;

  // --- Write reports ---
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = join(reportDir, `recall-impact-replay-${mode.label.toLowerCase()}-${stamp}.json`);
  const mdPath = join(reportDir, `recall-impact-replay-${mode.label.toLowerCase()}-${stamp}.md`);

  const fullReport = {
    mode: mode.label,
    seed: mode.seed,
    n: pairs.length,
    generator: { baseUrl: gen.baseUrl, model: gen.model, temperature: GEN_TEMPERATURE, maxTokens: GEN_MAX_TOKENS, reasoningEffort: REASONING_EFFORT ?? null },
    judge: { baseUrl: judge.baseUrl, model: judge.model, temperature: 0, maxTokens: JUDGE_MAX_TOKENS, reasoningEffort: REASONING_EFFORT ?? null },
    exclusions: state.exclusions,
    strataCounts: state.strataCounts,
    sessionIdResolution: { referenced: state.referencedIds, resolved: state.resolvedIds },
    genFailures,
    judgeFailures,
    malformedJudgeReplies: malformedTotal,
    wallTimeMs: { generation: state.genMs, judging: state.judgeMs },
    doubleJudge,
    verdict: verdictResult,
    tokenBuckets,
    factVsSessionRows: { sessionPointerRows: pairs.length, factInjectionRows: 0 },
    pairs,
  };
  writeFileSync(jsonPath, JSON.stringify(fullReport, null, 2), "utf8");
  writeFileSync(mdPath, renderMarkdown(mode, fullReport, quartiles), "utf8");
  unlinkSync(spath);

  console.log(`\nJSON report: ${jsonPath}`);
  console.log(`Markdown report: ${mdPath}`);
  console.log(mode.label === "FULL" ? `\nVerdict: ${verdictResult.verdict}` : "\n(PILOT — no verdict computed for n=10)");
}

function exitCheckpoint(spath: string, state: EvalState, phase: string): void {
  saveState(spath, state);
  const settled = state.pairs.filter((p) => p.winner !== null || p.genFailed || p.judgeFailed).length;
  console.log(`CHECKPOINT (budget spent during ${phase}): ${settled}/${state.pairs.length} pairs settled — re-run the same command to resume`);
}

function renderMarkdown(
  mode: Mode,
  report: {
    n: number;
    exclusions: ExclusionCounts;
    strataCounts: Readonly<Record<string, number>>;
    genFailures: number;
    judgeFailures: number;
    malformedJudgeReplies: number;
    wallTimeMs: { generation: number; judging: number };
    doubleJudge: { n: number; agree: number } | null;
    verdict: ReturnType<typeof computeVerdict>;
    tokenBuckets: ReadonlyArray<{ quartile: number; n: number; winRate: number; decisiveRate: number }>;
    factVsSessionRows: { sessionPointerRows: number; factInjectionRows: number };
    generator: { model: string; baseUrl: string; temperature: number; maxTokens: number; reasoningEffort: string | null };
    judge: { model: string; baseUrl: string; temperature: number; maxTokens: number; reasoningEffort: string | null };
  },
  quartiles: readonly [number, number, number],
): string {
  const lines: string[] = [];
  lines.push(`# Recall-impact replay eval — ${mode.label}`);
  lines.push("");
  lines.push(`Spec: docs/superpowers/specs/2026-07-21-recall-impact-replay-eval-design.md`);
  lines.push(`Seed: ${mode.seed} · n sampled: ${report.n}`);
  lines.push("");
  if (mode.label === "PILOT") {
    lines.push(
      "**PILOT RUN — mechanics validation only. n=10 is far below the pre-registered n=100 and MUST NOT be used to infer PASS/NULL/HARM. No verdict is reported below.**",
    );
    lines.push("");
  }
  lines.push("## Identities & settings");
  const effortNote = (e: string | null): string => (e ? `, reasoning_effort ${e}` : "");
  lines.push(`- Generator: \`${report.generator.model}\` @ \`${report.generator.baseUrl}\` (temperature ${report.generator.temperature}, max_tokens ${report.generator.maxTokens}${effortNote(report.generator.reasoningEffort)})`);
  lines.push(`- Judge: \`${report.judge.model}\` @ \`${report.judge.baseUrl}\` (temperature ${report.judge.temperature}, max_tokens ${report.judge.maxTokens}${effortNote(report.judge.reasoningEffort)})`);
  lines.push("");
  lines.push("## Sample");
  lines.push(`- Eligible pool exclusions: too_short=${report.exclusions.tooShort}, duplicate=${report.exclusions.duplicate}, unresolved=${report.exclusions.unresolved}, leakage=${report.exclusions.leakage}`);
  lines.push(`- Strata (month): ${JSON.stringify(report.strataCounts)}`);
  lines.push(`- Generation failures: ${report.genFailures} · Judge call failures: ${report.judgeFailures} · Malformed judge replies (counted as tie): ${report.malformedJudgeReplies}`);
  lines.push("");
  lines.push("## Wall time");
  lines.push(`- Generation: ${(report.wallTimeMs.generation / 1000).toFixed(1)}s`);
  lines.push(`- Judging: ${(report.wallTimeMs.judging / 1000).toFixed(1)}s`);
  lines.push("");

  if (mode.label === "FULL") {
    const v = report.verdict;
    lines.push("## Pre-registered gate (mechanical — no editorializing)");
    lines.push("");
    lines.push(`| Metric | Value | Bar | Met |`);
    lines.push(`|---|---|---|---|`);
    lines.push(`| decisive_rate | ${v.decisiveRate.toFixed(3)} | >= ${GATE_THRESHOLDS.decisiveRatePass} | ${v.decisiveRate >= GATE_THRESHOLDS.decisiveRatePass ? "yes" : "no"} |`);
    lines.push(`| win_rate (arm A among decisive) | ${v.winRate.toFixed(3)} | >= ${GATE_THRESHOLDS.winRatePass} | ${v.winRate >= GATE_THRESHOLDS.winRatePass ? "yes" : "no"} |`);
    lines.push(`| arm B share (HARM check) | ${v.armBShare.toFixed(3)} | <= ${GATE_THRESHOLDS.harmShare} | ${!v.harm ? "yes" : "no"} |`);
    lines.push("");
    lines.push(`**VERDICT: ${v.verdict}${v.harm ? " (HARM)" : ""}**`);
    lines.push("");
    if (v.verdict === "NULL" && !v.harm) {
      lines.push(
        "Interpretation (pre-registered, verbatim): recall is cheap but unproven at changing outputs; effort shifts from building NLM to using NLM until evidence changes.",
      );
    }
    if (v.harm) {
      lines.push(
        "Interpretation (pre-registered, verbatim): arm B (no injection) won a majority of decisive pairs beyond the HARM threshold — evidence injection actively hurts. Treated as NULL plus a filed investigation task.",
      );
    }
    lines.push("");
    if (report.doubleJudge) {
      const rate = report.doubleJudge.n > 0 ? (report.doubleJudge.agree / report.doubleJudge.n) : 0;
      lines.push(`## Judge consistency (double-judge subsample, n=${report.doubleJudge.n})`);
      lines.push(`- Agreement: ${report.doubleJudge.agree}/${report.doubleJudge.n} (${(rate * 100).toFixed(1)}%)`);
      lines.push("");
    }
    lines.push("## Buckets (secondary, reported not gating)");
    lines.push("");
    lines.push(`Injected-token quartile cut points: Q1=${quartiles[0].toFixed(0)}, Q2=${quartiles[1].toFixed(0)}, Q3=${quartiles[2].toFixed(0)}`);
    lines.push("");
    lines.push(`| Quartile | n | win_rate | decisive_rate |`);
    lines.push(`|---|---|---|---|`);
    for (const b of report.tokenBuckets) {
      lines.push(`| Q${b.quartile} | ${b.n} | ${b.winRate.toFixed(3)} | ${b.decisiveRate.toFixed(3)} |`);
    }
    lines.push("");
    lines.push(
      `Fact-injection vs session-pointer rows: session-pointer=${report.factVsSessionRows.sessionPointerRows}, fact-injection=${report.factVsSessionRows.factInjectionRows} (the hook log never records fact ids in \`wouldInject\` — facts are rendered into the live block but not logged — so this bucket is always 0 for historical replay; reported as a known limitation, not a result).`,
    );
  }

  return lines.join("\n");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
