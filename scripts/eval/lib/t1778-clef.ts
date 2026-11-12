/**
 * Shared helpers for the T1778 clef-flash evaluation.
 *
 * Talks to the local oMLX systemone endpoint directly (no gateway, no key) and
 * lets the caller pick the model per call, which src/llm/clef-client.ts cannot
 * do without a src change (it hardcodes the gateway path and defaults the model).
 * Nothing here is imported by src/ — evaluation only.
 */
import { loadavg } from "node:os";
import type { ClefAnswer, ClefQuestion } from "../../../src/llm/clef-client.js";

export type ClefModel = "clef-flash-oQ8e" | "clef-oQ4e";

/** Direct oMLX base; the systemone route is `${base}/v1/systemone`. */
export const CLEF_URL = process.env["T1778_CLEF_URL"] ?? "http://127.0.0.1:8080";

export interface AskResult {
  readonly answers: Record<string, ClefAnswer>;
  /** Wall clock of the single HTTP round trip. */
  readonly ms: number;
  readonly inputTokens: number;
}

/** One systemone call. Throws on HTTP or shape errors so callers decide the failure policy. */
export async function ask(
  model: ClefModel,
  state: unknown,
  questions: Record<string, ClefQuestion>,
  opts: { timeoutMs?: number; attempts?: number } = {},
): Promise<AskResult> {
  const attempts = opts.attempts ?? 3;
  let last = "unreachable";
  for (let i = 0; i < attempts; i++) {
    const t0 = performance.now();
    try {
      const res = await fetch(`${CLEF_URL}/v1/systemone`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, state, questions }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
      const json = (await res.json()) as { answers?: Record<string, ClefAnswer>; usage?: { input_tokens?: number } };
      if (!json.answers) throw new Error("reply has no answers");
      return { answers: json.answers, ms: Math.round(performance.now() - t0), inputTokens: json.usage?.input_tokens ?? 0 };
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw new Error(`clef ${model} failed after ${attempts} attempts: ${last}`);
}

/** Warm the model with a trivial call so the measured calls are not cold-start. */
export async function warm(model: ClefModel): Promise<number> {
  const r = await ask(model, { session: "User: hello." }, { ping: { type: "noul", instructions: "Is this a greeting?" } });
  return r.ms;
}

export function pctl(xs: readonly number[], p: number): number {
  if (!xs.length) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.floor(p * (s.length - 1)));
  return s[i]!;
}

export const median = (xs: readonly number[]): number => pctl(xs, 0.5);

/** Machine load at call time — Clef latency on this host is load-dependent. */
export const loadAvg = (): string => loadavg().map((v) => v.toFixed(1)).join(" ");

/** Bounded-concurrency map that keeps input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  }));
  return out;
}

/** Deterministic 32-bit hash (FNV-1a) for reproducible sampling/assignment. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Score answers carry a 0..n-1 ordinal; noul carries a probability. */
export function scoreOf(a: ClefAnswer | undefined): number | null {
  return a && a.type === "score" ? a.score : null;
}
export function noulOf(a: ClefAnswer | undefined): number | null {
  return a && a.type === "noul" ? a.noul : null;
}
export function choiceOf(a: ClefAnswer | undefined): string | null {
  return a && a.type === "choice" ? a.choice : null;
}
