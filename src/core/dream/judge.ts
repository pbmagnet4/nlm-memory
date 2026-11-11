/**
 * Dream-judge client (T1609 contradiction pass).
 *
 * Given a stored fact's text plus the source transcript excerpt it was
 * extracted from, ask the dream model on the classifier lane whether the
 * fact is `still-true`, `contradicted` or `unverifiable`, with a short
 * verbatim evidence quote from the excerpt.
 *
 * Transport goes through the existing LLMClient port (`complete()` chat
 * lane) so callers wire whatever classifier client they already have and
 * tests stub the port — this module never touches the network. The resolved
 * model is passed as the `complete()` model override, so the dream-model
 * knob selects the weights that judge, not just the audit label.
 *
 * Invariants:
 *  - The dream lane always runs without thinking tokens: every call passes
 *    `enable_thinking: false` in the chat options. Ollama maps it onto the
 *    `think` request field; OpenAI-compatible gateway clients merge
 *    `chat_template_kwargs.enable_thinking=false` over their constructed
 *    body (the same switch `ClassifierBox` sets at construction); the
 *    per-call flag wins over construction-time tuning in both.
 *  - Empty completion content is a FAILED CALL, never a verdict: the model
 *    answered nothing, which is not the same as "unverifiable". It throws
 *    `DreamJudgeError` so the caller can retry or leave the fact alone.
 *  - Model selection: explicit `model` dep > NLM_DREAM_MODEL env > DEFAULT_DREAM_MODEL.
 *  - No hostnames, IPs or URLs live here — endpoint choice belongs to the
 *    wired client, not this module.
 */

import { stripJsonFences } from "@core/classifier/prompt.js";
import type { LLMClient } from "@ports/llm-client.js";

/** Dream judge default: small instruct model on the classifier lane, scored
 *  sufficient for three-way support/contradiction calls (contradiction pass). */
export const DEFAULT_DREAM_MODEL = "gemma-4-12B-it-oQ4e-mtp";

export const DREAM_MODEL_ENV = "NLM_DREAM_MODEL";

/** NLM_DREAM_MODEL when set to a non-blank value, else the default. */
export function dreamModelFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env[DREAM_MODEL_ENV] ?? "").trim();
  return raw.length > 0 ? raw : DEFAULT_DREAM_MODEL;
}

export type DreamVerdict = "still-true" | "contradicted" | "unverifiable";

export interface DreamJudgement {
  readonly verdict: DreamVerdict;
  /** Short verbatim quote from the excerpt backing the verdict ("" when the
   *  model gave none for `unverifiable`). */
  readonly evidenceQuote: string;
  /** The model that produced this judgement (resolved precedence winner). */
  readonly model: string;
}

/** A failed dream-judge call: no chat lane, empty content, or a reply that
 *  is not a valid verdict object. Distinct from transport errors, which
 *  propagate from the wired client (typically LLMUnreachableError). */
export class DreamJudgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DreamJudgeError";
  }
}

/**
 * Chat options as the dream lane sends them. The port's `complete()` opts
 * are `{ signal?, maxTokens? }`; `enable_thinking` is the extra key the
 * classifier-lane gateway clients consume (method-parameter bivariance lets
 * any port client satisfy this call shape — see judgeDreamFact).
 */
export interface DreamJudgeChatOptions {
  readonly signal?: AbortSignal;
  readonly maxTokens?: number;
  readonly enable_thinking?: boolean;
  readonly model?: string;
}

export interface DreamJudgeDeps {
  readonly llm: LLMClient;
  /** Overrides NLM_DREAM_MODEL; both override DEFAULT_DREAM_MODEL. */
  readonly model?: string;
  /** Env source for the override, injectable for tests (default process.env). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly maxTokens?: number;
  readonly signal?: AbortSignal;
}

const EVIDENCE_MAX_CHARS = 300;

export const DREAM_JUDGE_SYSTEM_PROMPT = `You audit a stored memory fact against a source transcript excerpt. Decide exactly one verdict:

still-true: the excerpt supports the fact.
contradicted: the excerpt states the opposite — it gives the incompatible counter-value itself — or a newer statement in it supersedes the fact.
unverifiable: the excerpt neither supports nor contradicts the fact (wrong scope, missing context, or it does not mention the fact's subject).

Rules:
- Judge only from the excerpt. Your "evidence" MUST be a short verbatim quote copied from the excerpt, or an empty string for unverifiable when nothing is relevant.
- "contradicted" needs a DIRECT negation: the evidence quote must state the incompatible counter-value, not merely differ in framing, rounding, or source. Approximate numeric agreement is corroboration, never contradiction: component counts that sum to the fact's total, percentages within a point, and "~"-qualified counts that match are still-true (or unverifiable when unrelated).
- A missing tool, client, or integration never contradicts an API or endpoint existence claim, and a missing API never contradicts a tool claim: different layers, compatible claims. That is unverifiable (or still-true when the excerpt otherwise supports the fact), never contradicted.
- Doubt is "unverifiable", never "still-true".

Reply with one JSON object and nothing else:
{"verdict":"still-true"|"contradicted"|"unverifiable","evidence":"<short verbatim quote from the excerpt>"}`;

/** Format the user turn. The excerpt is untrusted data — the prompt frames
 *  it as material to judge, never as instructions. */
export function buildDreamJudgeUserPrompt(factText: string, transcriptExcerpt: string): string {
  return `FACT:\n${factText.trim()}\n\nTRANSCRIPT EXCERPT:\n"""\n${transcriptExcerpt.trim()}\n"""`;
}

/** API-layer markers vs tool-layer markers for the cross-layer rule below.
 *  Deliberately narrow: only unambiguous markers count — generic words
 *  ("rest", "post", "route", "client", "tool(s)", "integration", "view",
 *  "get") stay out so only an explicit layer term on each side triggers
 *  the downgrade. */
const API_LAYER_RE = /\b(api|endpoint|http)\b/i;
const TOOL_LAYER_RE = /\b(mcp|sdk)\b/i;

const MONTH_NAME_RE = /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b/i;
/** ISO-ish date fragments (YYYY-MM, YYYY-MM-DD, YYYY/MM/DD): a 4-digit
 *  number inside one is a year, not a count. */
const ISO_DATE_RE = /\d{4}[-/]\d{1,2}(?:[-/]\d{1,2})?/g;

/** Integers in year range are years only with date context: a month name
 *  within ~12 chars, or participation in an ISO-ish date fragment.
 *  Bare counts ("migrated 2000 rows") are never years. */
function isYearLikeInContext(text: string, raw: string, index: number): boolean {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1800 || n > 2200) return false;
  const window = text.slice(Math.max(0, index - 12), index + raw.length + 12);
  if (MONTH_NAME_RE.test(window)) return true;
  for (const m of text.matchAll(ISO_DATE_RE)) {
    const start = m.index ?? 0;
    if (index >= start && index < start + m[0].length) return true;
  }
  return false;
}

function extractCountables(text: string): number[] {
  // Blank whole ISO fragments first: their month/day parts are not counts.
  const scrubbed = text.replace(ISO_DATE_RE, (m) => " ".repeat(m.length));
  const out: number[] = [];
  for (const m of scrubbed.matchAll(/-?\d+(?:\.\d+)?/g)) {
    const n = Number(m[0]);
    if (!Number.isFinite(n)) continue;
    if (isYearLikeInContext(scrubbed, m[0], m.index ?? 0)) continue;
    out.push(n);
  }
  return out;
}

/** Rounding noise: one point for small counts/percentages, 1% above that. */
function agreeTol(n: number): number {
  return Math.max(1, Math.abs(n) * 0.01);
}

/** Small counts (<=2) agree only on exact equality: the unit floor would
 *  otherwise call 0-vs-1 or 1-vs-2 agreement. Tolerance applies above that. */
function numbersAgree(n: number, m: number): boolean {
  if (Math.abs(n) <= 2 && Math.abs(m) <= 2) return n === m;
  return Math.abs(n - m) <= agreeTol(n);
}

/** Sum of each "+"-joined run ("52 tracked + 37 untracked" adds 89) — never
 *  the sum of all numbers in the text ("day 10: 20 users + 30 guests" adds
 *  only 50). Numbers count as joined when only words/space sit between each
 *  number and its "+", so "20 users + 30" runs but the unjoined "day 10"
 *  stays out. */
function plusRunSums(text: string): number[] {
  const sums: number[] = [];
  for (const m of text.matchAll(/(-?\d+(?:\.\d+)?(?:[^+\d]*\+[^+\d]*-?\d+(?:\.\d+)?)+)/g)) {
    const parts = (m[1] ?? "").match(/-?\d+(?:\.\d+)?/g);
    if (parts && parts.length >= 2) sums.push(parts.reduce((a, b) => a + Number(b), 0));
  }
  return sums;
}

/** Split fact text into its subject/predicate context (before the first ":")
 *  and its value (after it). `factJudgementText` builds
 *  `${subject} ${predicate}: ${value}`, so numbers before the colon scope
 *  the claim (task ids, sprint numbers) while numbers after it are the
 *  claim's value under test. No colon means no separable context. */
function splitFactValue(factText: string): { contextNums: number[]; valueText: string } {
  const colon = factText.indexOf(":");
  if (colon < 0) return { contextNums: [], valueText: factText };
  return { contextNums: extractCountables(factText.slice(0, colon)), valueText: factText.slice(colon + 1) };
}

/** True when any fact/evidence number pair agrees within rounding noise —
 *  approximate numeric agreement, which is corroboration per the prompt.
 *  Only the fact's VALUE numbers count (plus "+"-run sums derived from the
 *  value): numbers from the subject/predicate context never agree, so a
 *  task id in the subject cannot mask a genuine value conflict. Evidence
 *  numbers exactly restating a fact number are ignored when the evidence
 *  also states a distinct number ("90 was wrong, it is 20 files" judges
 *  90-vs-20, not the restated 90-vs-90). The restatement filter applies to
 *  literal evidence numbers only; derived "+"-run sums are always kept, so
 *  a sum that equals the fact value ("52 + 37 = 89") corroborates. */
function numbersRoughlyAgree(factText: string, evidenceQuote: string): boolean {
  const { contextNums, valueText } = splitFactValue(factText);
  const contextSet = new Set(contextNums);
  const factNums = [...extractCountables(valueText), ...plusRunSums(valueText)].filter((n) => !contextSet.has(n));
  const evLiterals = extractCountables(evidenceQuote).filter((n) => !contextSet.has(n));
  const evSums = plusRunSums(evidenceQuote).filter((n) => !contextSet.has(n));
  let evNums = [...evLiterals, ...evSums];
  const distinct = evLiterals.filter((e) => !factNums.some((f) => f === e));
  if (distinct.length > 0 && distinct.length < evLiterals.length) evNums = [...distinct, ...evSums];
  return factNums.some((n) => evNums.some((m) => numbersAgree(n, m)));
}

function mentionsOnly(text: string, re: RegExp, other: RegExp): boolean {
  return re.test(text) && !other.test(text);
}

/** True when the fact claims on one layer (API/endpoint existence) and the
 *  evidence answers on the other (tool/client presence or absence): different
 *  layers, compatible claims — never a contradiction, in either direction. */
function isCrossLayerClaim(factText: string, evidenceQuote: string): boolean {
  return (
    (mentionsOnly(factText, API_LAYER_RE, TOOL_LAYER_RE) &&
      mentionsOnly(evidenceQuote, TOOL_LAYER_RE, API_LAYER_RE)) ||
    (mentionsOnly(factText, TOOL_LAYER_RE, API_LAYER_RE) &&
      mentionsOnly(evidenceQuote, API_LAYER_RE, TOOL_LAYER_RE))
  );
}

/**
 * Deterministic backstop for a "contradicted" verdict (precision gate: two
 * compatible facts were retired as contradicted). Returns false when the
 * evidence quote cannot directly negate the fact — approximate numeric
 * agreement, or a cross-layer tool/API claim — so the caller must downgrade
 * to unverifiable, never retire. Anything else returns true: the model's
 * verdict stands, subject to the existing empty/off-excerpt evidence guards.
 */
export function contradictedClaimStands(factText: string, evidenceQuote: string): boolean {
  if (numbersRoughlyAgree(factText, evidenceQuote)) return false;
  if (isCrossLayerClaim(factText, evidenceQuote)) return false;
  return true;
}

const VERDICTS: ReadonlySet<string> = new Set<DreamVerdict>(["still-true", "contradicted", "unverifiable"]);

/** Strict parse of the model reply. Returns null on anything but a valid verdict. */
function parseDreamJudgeReply(raw: string): { verdict: DreamVerdict; evidenceQuote: string } | null {
  const text = stripJsonFences(raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim());
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  const normalized = typeof o["verdict"] === "string" ? o["verdict"].trim().toLowerCase().replace(/[_\s]+/g, "-") : "";
  if (!VERDICTS.has(normalized)) return null;
  const evidenceQuote = typeof o["evidence"] === "string" ? o["evidence"].trim().slice(0, EVIDENCE_MAX_CHARS) : "";
  return { verdict: normalized as DreamVerdict, evidenceQuote };
}

/**
 * Ask the dream model whether `factText` still holds given `transcriptExcerpt`.
 * Throws DreamJudgeError when there is no chat lane, the completion content
 * is empty (a failed call, not a verdict), or the reply is not a valid
 * verdict object. Transport errors from the client propagate untouched.
 */
export async function judgeDreamFact(
  deps: DreamJudgeDeps,
  factText: string,
  transcriptExcerpt: string,
): Promise<DreamJudgement> {
  const env = deps.env ?? process.env;
  const model = deps.model?.trim() || dreamModelFromEnv(env);
  if (!deps.llm.complete) throw new DreamJudgeError(`dream judge needs a chat-completion lane on the classifier client (model ${model})`);

  // Handed over as a typed variable, not a literal: the dream lane's extra
  // enable_thinking key must survive without tripping excess-property checks
  // on the port's narrower opts.
  const chatOpts: DreamJudgeChatOptions = {
    enable_thinking: false,
    model,
    ...(deps.signal ? { signal: deps.signal } : {}),
    ...(deps.maxTokens !== undefined ? { maxTokens: deps.maxTokens } : {}),
  };

  const raw = await deps.llm.complete(DREAM_JUDGE_SYSTEM_PROMPT, buildDreamJudgeUserPrompt(factText, transcriptExcerpt), chatOpts);
  if (raw.trim() === "") throw new DreamJudgeError(`dream judge returned empty content (model ${model}) — treating as a failed call`);

  const parsed = parseDreamJudgeReply(raw);
  if (!parsed) throw new DreamJudgeError(`dream judge reply is not a valid verdict object (model ${model}): ${raw.slice(0, 200)}`);
  return { verdict: parsed.verdict, evidenceQuote: parsed.evidenceQuote, model };
}
