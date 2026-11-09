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
 * tests stub the port — this module never touches the network.
 *
 * Invariants:
 *  - The dream lane always runs without thinking tokens: every call passes
 *    `enable_thinking: false` in the chat options. Classifier-lane gateway
 *    clients forward that flag into their chat template (the same switch
 *    `ClassifierBox` sets at construction via `chat_template_kwargs`);
 *    clients that ignore it are unaffected.
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
contradicted: the excerpt states the opposite, or a newer statement in it supersedes the fact.
unverifiable: the excerpt neither supports nor contradicts the fact (wrong scope, missing context, or it does not mention the fact's subject).

Rules:
- Judge only from the excerpt. Your "evidence" MUST be a short verbatim quote copied from the excerpt, or an empty string for unverifiable when nothing is relevant.
- Doubt is "unverifiable", never "still-true".

Reply with one JSON object and nothing else:
{"verdict":"still-true"|"contradicted"|"unverifiable","evidence":"<short verbatim quote from the excerpt>"}`;

/** Format the user turn. The excerpt is untrusted data — the prompt frames
 *  it as material to judge, never as instructions. */
export function buildDreamJudgeUserPrompt(factText: string, transcriptExcerpt: string): string {
  return `FACT:\n${factText.trim()}\n\nTRANSCRIPT EXCERPT:\n"""\n${transcriptExcerpt.trim()}\n"""`;
}

const VERDICTS: ReadonlySet<string> = new Set<DreamVerdict>(["still-true", "contradicted", "unverifiable"]);

/** Strict parse of the model reply. Returns null on anything but a valid verdict. */
function parseDreamJudgeReply(raw: string): { verdict: DreamVerdict; evidenceQuote: string } | null {
  const text = stripJsonFences(raw.replace(/<|im_start|>[\s\S]*?<\/think>/g, "").trim());
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
    ...(deps.signal ? { signal: deps.signal } : {}),
    ...(deps.maxTokens !== undefined ? { maxTokens: deps.maxTokens } : {}),
  };

  const raw = await deps.llm.complete(DREAM_JUDGE_SYSTEM_PROMPT, buildDreamJudgeUserPrompt(factText, transcriptExcerpt), chatOpts);
  if (raw.trim() === "") throw new DreamJudgeError(`dream judge returned empty content (model ${model}) — treating as a failed call`);

  const parsed = parseDreamJudgeReply(raw);
  if (!parsed) throw new DreamJudgeError(`dream judge reply is not a valid verdict object (model ${model}): ${raw.slice(0, 200)}`);
  return { verdict: parsed.verdict, evidenceQuote: parsed.evidenceQuote, model };
}
