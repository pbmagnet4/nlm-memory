/**
 * Pre-injection relevance gate (recall-precision option A).
 *
 * A small local model predicts, from the prompt + a candidate's context alone
 * (no agent response yet), whether injecting the candidate would help. The
 * prompt is deliberately CONSERVATIVE: drop only the clearly cross-topic
 * candidates, keep anything with a plausible connection. Measured on the
 * frontier gold (gate-feasibility.ts): keeps 96% of informed injections while
 * skipping 25% of off-topic. The asymmetry is intentional — dropping a useful
 * memory forfeits recall's signature value, so the gate fails toward "relevant"
 * (here and on any judge error).
 *
 * Runtime home so the hot-path hook has no eval-tooling dependency; the eval
 * harness imports RECALL_GATE_SYSTEM from here so validated == shipped.
 */
import type { GateMode } from "./prompt-recall-hook.js";

export const RECALL_GATE_MODEL = "qwen3.5:4b";

export const RECALL_GATE_SYSTEM =
  "You are a recall GATE protecting against off-topic memory injection. Given a USER PROMPT and a CANDIDATE prior-session context, answer irrelevant ONLY when the candidate is CLEARLY about a completely different topic, project, or task than the prompt (e.g. the prompt is about debugging a website and the candidate is about a trading pipeline). If there is ANY plausible topical connection, or you are at all unsure, answer relevant. Dropping a useful memory is worse than keeping a marginal one. You do NOT see the assistant's answer. " +
  'Output {"gate":"relevant"|"irrelevant"}.';

const GATE_FORMAT = { type: "object", properties: { gate: { type: "string", enum: ["relevant", "irrelevant"] } }, required: ["gate"] };
const GATE_OPTS = { temperature: 0, top_p: 1, top_k: 0, presence_penalty: 0, frequency_penalty: 0 };

/** Read the gate mode from env. Absent / "off" / unknown => undefined (gate off). */
export function parseRecallGateMode(env: NodeJS.ProcessEnv = process.env): GateMode | undefined {
  const v = env["NLM_HOOK_RECALL_GATE"]?.trim();
  return v === "shadow" || v === "live" ? v : undefined;
}

/**
 * A gate judge backed by an Ollama-compatible local endpoint. Fails toward
 * "relevant" on any error so the gate can never drop a candidate due to an
 * infra blip — consistent with the hook's fail-open contract.
 */
/** Bound the gate's hot-path cost. A cold model load can take tens of seconds;
 * past this the gate gives up and keeps the candidate rather than block the prompt. */
export const GATE_TIMEOUT_MS = 4000;

export function makeOllamaGate(
  url: string,
  model: string = RECALL_GATE_MODEL,
  timeoutMs: number = GATE_TIMEOUT_MS,
): (prompt: string, candidate: string) => Promise<"relevant" | "irrelevant"> {
  return async (prompt, candidate) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const r = await fetch(`${url}/api/chat`, {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          stream: false,
          think: false,
          // Keep the gate model resident between fires so only the first fire
          // pays the cold-load; subsequent gates are ~1 judge call.
          keep_alive: "15m",
          format: GATE_FORMAT,
          options: GATE_OPTS,
          messages: [
            { role: "system", content: RECALL_GATE_SYSTEM },
            { role: "user", content: `USER PROMPT:\n${prompt}\n\nCANDIDATE CONTEXT:\n${candidate}` },
          ],
        }),
      });
      const d = (await r.json()) as { message?: { content?: string } };
      const v = (JSON.parse(d.message?.content ?? "{}") as { gate?: string }).gate;
      return v === "irrelevant" ? "irrelevant" : "relevant";
    } catch {
      return "relevant";
    } finally {
      clearTimeout(timer);
    }
  };
}
