/**
 * The standing usefulness judge — single source of truth for scoring whether an
 * agent's RESPONSE used the recall context that was injected into it.
 *
 * Config is the one validated against the frontier gold set (~/.nlm/eval/
 * gold-usefulness.jsonl, n=77) on 2026-06-23: model qwen3.5:4b, the "naive"
 * prompt (verdict-only — forcing the 4B model to write evidence/reasoning first
 * collapses every verdict to "unused"), and clean greedy sampling. Sampling was
 * proven a non-lever for this task (presence_penalty/top_p/top_k give identical
 * output at temperature 0 because the output is a single fixed-shape JSON), so
 * the knobs are pinned to a neutral deterministic classifier rather than the
 * model's chat-tuned Modelfile defaults.
 *
 * Result on gold: 75% exact 3-way agreement, 86% binary (informed vs off-topic),
 * 96% specificity, aggregate usefulness matching the gold exactly. The reliable
 * signal is binary + aggregate; the used-vs-partial split is inherently noisy.
 *
 * tune-usefulness-judge.ts imports DEFS from here so the experiment bench and the
 * shipped path can never drift on the prompt.
 */

export type Verdict = "used" | "partial" | "unused";

export const USEFULNESS_DEFS =
  "used = the response clearly drew on a SPECIFIC fact/value/name/detail from the injected context that is NOT in the prompt and NOT generic. partial = the injected context is on-topic and plausibly informed the response, but there is no specific borrowed detail. unused = the injected context is off-topic or absent from the response. Topical word-overlap ALONE is never 'used'.";

export const USEFULNESS_SYSTEM =
  `Judge whether the assistant RESPONSE used information from the INJECTED context. ${USEFULNESS_DEFS} Output {"verdict":"..."}.`;

export const USEFULNESS_MODEL = "qwen3.5:4b";

const FORMAT = {
  type: "object",
  properties: { verdict: { type: "string", enum: ["used", "partial", "unused"] } },
  required: ["verdict"],
} as const;

// Neutral deterministic classifier. Proven equivalent to the model's chat
// defaults at temp 0, so pinned here rather than inherited from the Modelfile.
const OPTS = { temperature: 0, top_p: 1, top_k: 0, presence_penalty: 0, frequency_penalty: 0 } as const;

export function parseVerdict(s: string | undefined): Verdict {
  const t = (s ?? "").toLowerCase();
  if (t.includes("unused")) return "unused";
  if (t.includes("partial")) return "partial";
  if (t.includes("used")) return "used";
  return "unused";
}

export interface Triple { prompt: string; context: string; response: string }

export async function judgeUsefulness(
  url: string,
  model: string,
  t: Triple,
): Promise<Verdict> {
  const res = await fetch(`${url}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      think: false,
      format: FORMAT,
      options: OPTS,
      messages: [
        { role: "system", content: USEFULNESS_SYSTEM },
        { role: "user", content: `USER PROMPT:\n${t.prompt}\n\nINJECTED CONTEXT:\n${t.context}\n\nASSISTANT RESPONSE:\n${t.response}` },
      ],
    }),
  });
  const data = (await res.json()) as { message?: { content?: string } };
  return parseVerdict((JSON.parse(data.message?.content ?? "{}") as { verdict?: string }).verdict);
}
