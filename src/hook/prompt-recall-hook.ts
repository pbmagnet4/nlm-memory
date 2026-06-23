/**
 * UserPromptSubmit hook entrypoint for NLM recall.
 *
 * runHook is the testable orchestration; main() is the thin process wrapper
 * (stdin / stdout / fetch / env). Every path is fail-open: any error yields
 * no output and a clean exit, so the hook can never block or fail a prompt.
 *
 * Mode is read from NLM_HOOK_MODE (default "shadow"). Runtime attribution is
 * read from NLM_HOOK_RUNTIME (default "claude-code") so packaged hooks can
 * share this entrypoint without polluting query logs.
 */

import { pathToFileURL } from "node:url";
import { classifyPrompt } from "@core/hook/gate.js";
import { recentConversationContext, topicalWordCount } from "./recent-context.js";
import { appendHookLog } from "@core/hook/hook-log.js";
import { loadSurfaced, recordSurfaced } from "@core/hook/memo.js";
import { formatPointerBlock, type PointerExemplar, type PointerFact } from "@core/hook/pointer-block.js";
import { selectHits, type RecallHitInput } from "@core/hook/select.js";
import { autoloadEnv } from "../llm/env-autoload.js";
import { recallOverHttp } from "./recall-over-http.js";
import { parseScoreFloor, parseRelativeFloor } from "./score-floor.js";
import { makeOllamaGate, parseRecallGateMode } from "./recall-gate.js";

// Keyword recall returns raw BM25 scores (unbounded, not the 0..1 hybrid
// scale). FTS5 MATCH already gates relevance — only lexically-matching
// sessions come back — so the default floor is 0. NLM_RECALL_SCORE_FLOOR lets
// an operator raise it once the shadow log's surfaced-vs-cited score
// distribution (nlm precision --verbose) justifies a real cutoff.
// parseScoreFloor guards against a bad env value: a non-numeric / non-finite /
// negative input falls back to 0 instead of silently deny-all'ing recall
// (matchScore >= NaN is always false in select.ts).
const SCORE_THRESHOLD = parseScoreFloor(process.env["NLM_RECALL_SCORE_FLOOR"]);
// Portable per-fire noise floor: drop tail hits below this fraction of the
// fire's median score. Default 0.9 (calibrated, #284) — trims weak tail recalls
// while keeping ~97% of cited ones. Only the per-message keyword path runs this;
// the session-start hybrid path is left unfiltered (unmeasured).
const RELATIVE_FLOOR = parseRelativeFloor(process.env["NLM_RECALL_REL_FLOOR"], 0.9);
const PER_FIRE_CAP = 3;
const PER_CONVERSATION_CAP = 10;
const PROMPT_PREVIEW_CHARS = 200;

export type HookMode = "shadow" | "live";

export function hookRuntimeFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw = env["NLM_HOOK_RUNTIME"]?.trim();
  return raw ? raw : "claude-code";
}

export interface HookInput {
  readonly prompt: string;
  readonly conversationId: string;
  /** Runtime transcript path, when the runtime exposes one (Claude Code does). */
  readonly transcriptPath?: string;
}

/**
 * The recall query. Default is the bare prompt (today's behavior). When the
 * context-recall flag is on AND the prompt is thin (few content words — the
 * measured off-topic failure band) AND a transcript is available, prepend the
 * recent conversation turns so the query carries the topic the thin prompt
 * lacks. Flag-gated + thin-only + fallback => never worse than today.
 */
export function buildRecallQuery(input: HookInput, env: NodeJS.ProcessEnv = process.env): string {
  if (env["NLM_HOOK_CONTEXT_RECALL"] !== "1") return input.prompt;
  if (!input.transcriptPath) return input.prompt;
  const minWords = Number.parseInt(env["NLM_HOOK_CONTEXT_MIN_WORDS"] ?? "3", 10);
  if (topicalWordCount(input.prompt) >= minWords) return input.prompt;
  const context = recentConversationContext(input.transcriptPath);
  return context ? `${context} ${input.prompt}` : input.prompt;
}

export interface RecallFetchResult {
  readonly hits: ReadonlyArray<RecallHitInput>;
  readonly facts: ReadonlyArray<PointerFact>;
  readonly exemplars?: ReadonlyArray<PointerExemplar>;
}

export type GateMode = "shadow" | "live";

export interface RecallGate {
  /** shadow = log decisions, inject as usual; live = drop irrelevant candidates. */
  readonly mode: GateMode;
  /** Predict, from the prompt and a candidate's context, whether to inject it. */
  readonly judge: (prompt: string, candidate: string) => Promise<"relevant" | "irrelevant">;
  /** Judge only the top N candidates (bounds hot-path latency). Unset = all. */
  readonly maxCandidates?: number;
}

export interface RunHookDeps {
  readonly mode: HookMode;
  /**
   * Returns hits + optional related facts. Older callers may return a
   * bare hit array; runHook normalizes both shapes.
   */
  readonly recall: (
    prompt: string,
  ) => Promise<ReadonlyArray<RecallHitInput> | RecallFetchResult>;
  /** Optional pre-injection relevance gate. Absent => no gating (today's behavior). */
  readonly recallGate?: RecallGate;
}

function normalizeRecall(
  raw: ReadonlyArray<RecallHitInput> | RecallFetchResult,
): RecallFetchResult {
  if (Array.isArray(raw)) return { hits: raw, facts: [] };
  return raw as RecallFetchResult;
}

/** Orchestration. Returns the text to emit on stdout ("" for nothing). */
export async function runHook(input: HookInput, deps: RunHookDeps): Promise<string> {
  const gate = classifyPrompt(input.prompt);
  const preview = input.prompt.slice(0, PROMPT_PREVIEW_CHARS);

  if (gate === "generative" || gate === "skip") {
    appendHookLog({
      ts: new Date().toISOString(),
      conversationId: input.conversationId,
      promptPreview: preview,
      gate,
      hits: [],
      wouldInject: [],
      estTokens: 0,
      mode: deps.mode,
    });
    return "";
  }

  let fetched: RecallFetchResult = { hits: [], facts: [] };
  try {
    fetched = normalizeRecall(await deps.recall(buildRecallQuery(input)));
  } catch {
    fetched = { hits: [], facts: [] };
  }
  const hits = fetched.hits;

  const surfaced = loadSurfaced(input.conversationId);
  const selected = selectHits({
    hits,
    surfaced,
    scoreThreshold: SCORE_THRESHOLD,
    relativeFloor: RELATIVE_FLOOR,
    perFireCap: PER_FIRE_CAP,
    perConversationCap: PER_CONVERSATION_CAP,
  });

  // Relevance gate: judge each selected candidate before injecting. In shadow
  // it only records decisions; in live it drops the irrelevant ones. Gate the
  // already-capped `selected` set (<=PER_FIRE_CAP), not the full hit list, to
  // bound hot-path latency.
  let gateDecisions: ReadonlyArray<{ id: string; gate: "relevant" | "irrelevant" }> | undefined;
  let injected = selected;
  if (deps.recallGate && selected.length > 0) {
    const g = deps.recallGate;
    const toGate = g.maxCandidates ? selected.slice(0, g.maxCandidates) : selected;
    gateDecisions = await Promise.all(
      toGate.map(async (h) => ({ id: h.id, gate: await g.judge(input.prompt, `${h.label}\n${h.summary ?? ""}`) })),
    );
    if (g.mode === "live") {
      const drop = new Set(gateDecisions.filter((d) => d.gate === "irrelevant").map((d) => d.id));
      injected = selected.filter((h) => !drop.has(h.id));
    }
  }

  const block = formatPointerBlock(injected, fetched.facts, fetched.exemplars);
  const estTokens = Math.ceil(block.length / 4);

  appendHookLog({
    ts: new Date().toISOString(),
    conversationId: input.conversationId,
    promptPreview: preview,
    gate,
    hits: hits.map((h) => ({ id: h.id, score: h.matchScore })),
    wouldInject: injected.map((h) => h.id),
    estTokens,
    mode: deps.mode,
    ...(gateDecisions ? { gateDecisions } : {}),
  });

  if (deps.mode === "live" && injected.length > 0) {
    recordSurfaced(input.conversationId, injected.map((h) => h.id));
    return block;
  }
  return "";
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

async function main(): Promise<void> {
  try {
    // Load ~/.nlm/.env so NLM_MCP_TOKEN is available before we hit /api/recall.
    // Hooks run as short-lived processes spawned by host runtimes with no shell
    // env beyond what the parent passed, so explicit .env load is required.
    autoloadEnv();
    const raw = await readStdin();
    const payload = JSON.parse(raw) as {
      prompt?: unknown;
      session_id?: unknown;
      transcript_path?: unknown;
    };
    const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
    const conversationId =
      typeof payload.session_id === "string" ? payload.session_id : "unknown";
    const transcriptPath =
      typeof payload.transcript_path === "string" ? payload.transcript_path : undefined;
    if (!prompt) return;

    const mode: HookMode = process.env["NLM_HOOK_MODE"] === "live" ? "live" : "shadow";
    const runtime = hookRuntimeFromEnv();
    const gateMode = parseRecallGateMode();
    const gateUrl = process.env["OLLAMA_URL"] ?? "http://127.0.0.1:11434";
    // Cap how many candidates the gate judges to bound hot-path latency
    // (~1 judge call/fire by default). Override with NLM_HOOK_RECALL_GATE_TOPN.
    const gateTopN = Math.max(1, Number.parseInt(process.env["NLM_HOOK_RECALL_GATE_TOPN"] ?? "1", 10) || 1);
    const out = await runHook(
      { prompt, conversationId, ...(transcriptPath ? { transcriptPath } : {}) },
      {
        mode,
        recall: (q) => recallOverHttp(q, runtime, conversationId === "unknown" ? undefined : conversationId),
        ...(gateMode ? { recallGate: { mode: gateMode, judge: makeOllamaGate(gateUrl), maxCandidates: gateTopN } } : {}),
      },
    );
    if (out) process.stdout.write(out);
  } catch {
    // Fail open — never block or fail a prompt.
  }
}

// Run main() only when invoked directly as a script, not when imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
