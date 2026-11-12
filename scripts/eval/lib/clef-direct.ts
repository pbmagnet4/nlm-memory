/**
 * Direct Clef client for the local oMLX endpoint (T1778 evals only).
 *
 * `src/llm/clef-client.ts` talks to the gateway pass-through and defaults to the
 * 27B Clef checkpoint; these evals compare checkpoints, so the model and base URL
 * have to be parameters. Same wire shape as the production client (`/v1/systemone`,
 * `{model, state, questions}`) minus the bearer token, which the local endpoint
 * does not use. Eval scripts only — production keeps going through clef-client.
 */
import { loadavg } from "node:os";
import type { ClefAnswer, ClefQuestion } from "../../../src/llm/clef-client.js";

export interface DirectOptions {
  readonly baseUrl: string;
  readonly model: string;
  readonly timeoutMs?: number;
}

export interface DirectReply {
  readonly answers: Record<string, ClefAnswer>;
  readonly ms: number;
  readonly stateChars: number;
}

export async function askClefDirect(
  state: unknown,
  questions: Record<string, ClefQuestion>,
  opts: DirectOptions,
): Promise<DirectReply> {
  const t0 = Date.now();
  const res = await fetch(`${opts.baseUrl}/v1/systemone`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: opts.model, state, questions }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
  });
  if (!res.ok) throw new Error(`clef HTTP ${res.status} ${res.statusText}`);
  const json = (await res.json()) as { answers?: Record<string, ClefAnswer> };
  if (!json.answers) throw new Error("clef reply has no answers");
  return { answers: json.answers, ms: Date.now() - t0, stateChars: JSON.stringify(state).length };
}

export const CLEF_MODELS = {
  flash: "clef-flash-oQ8e",
  base: "clef-oQ4e",
} as const;

export type ClefModelKey = keyof typeof CLEF_MODELS;

/** The MSM3 local oMLX endpoint (no key). Override with NLM_CLEF_URL. */
export const clefBaseUrl = (): string => process.env["NLM_CLEF_URL"] ?? "http://127.0.0.1:8080";

export function parseModelFlag(argv: readonly string[]): ClefModelKey {
  const i = argv.indexOf("--model");
  const inline = argv.find((a) => a.startsWith("--model="));
  const v = inline ? inline.split("=")[1] : i >= 0 ? argv[i + 1] : "flash";
  if (v === "flash" || v === CLEF_MODELS.flash) return "flash";
  if (v === "base" || v === "27b" || v === CLEF_MODELS.base) return "base";
  throw new Error(`unknown --model ${v}`);
}

/** Host load average — Clef latency on this machine is queue-bound, so a latency
 * number without the load next to it is not interpretable. */
export const load = (): string => loadavg().map((v) => v.toFixed(1)).join(" ");

/** Flags as --name value or --name=value. */
export function flag(name: string, def: string): string {
  const argv = process.argv.slice(2);
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.split("=")[1]!;
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--") ? argv[i + 1]! : def;
}

/** Serial and concurrent latency percentiles for one model, from measured ms values. */
export function latency(ms: readonly number[]): { n: number; p50: number; p95: number; max: number; total: number } {
  if (ms.length === 0) return { n: 0, p50: 0, p95: 0, max: 0, total: 0 };
  const s = [...ms].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, p50: q(0.5), p95: q(0.95), max: s[s.length - 1]!, total: s.reduce((a, b) => a + b, 0) };
}

/**
 * Run `work` over items with a fixed pool of workers, in item order, so a cache
 * restart only redoes what is still missing. Progress prints every `logEvery`.
 */
export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  work: (item: T, index: number) => Promise<R>,
  logEvery = 100,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.max(1, concurrency) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await work(items[i]!, i);
      if ((i + 1) % logEvery === 0) console.log(`  ${i + 1}/${items.length}`);
    }
  });
  await Promise.all(runners);
  return out;
}
