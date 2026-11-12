/**
 * Clef "system one" client. One call = one state + a bag of questions, answered
 * in a single forward pass (see docs/clef-decision-panel-findings.md).
 *
 * Two deployments, one client:
 *   • the classifier gateway, which mounts Clef under a pass-through prefix
 *     (`<base>/clef/v1/systemone`, bearer key) — the historical shape, and the
 *     default so existing callers do not change;
 *   • a direct inference host (oMLX on MSM5, LM Studio) that serves the bare
 *     `/v1/systemone` with no auth — set NLM_CLEF_BASE_URL plus
 *     NLM_CLEF_PATH=/v1/systemone.
 *
 * `clefSettingsFromEnv` is the settings side of that: it resolves both, so a
 * job that only needs "whatever Clef is configured" does not reimplement it.
 */
export type ClefQuestion =
  | { type: "noul"; instructions: string; criteria?: { true: string; false: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };

export type ClefAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: "score"; score: number; confidence: number; probabilities: Record<string, number>; legend: Record<string, string> };

/** Gateway pass-through prefix. Kept as the default so the pre-direct-Clef
 *  deployments (only NLM_CLASSIFIER_BASE_URL set) keep working untouched. */
export const CLEF_PATH_DEFAULT = "/clef/v1/systemone";
export const CLEF_MODEL_DEFAULT = "clef-oQ4e";

export interface ClefOptions {
  readonly baseUrl: string;
  /** Bearer token. Omit (or empty) for a direct host on a trusted network —
   *  no Authorization header is sent. */
  readonly apiKey?: string;
  /** Request path appended to baseUrl. Defaults to CLEF_PATH_DEFAULT. */
  readonly path?: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

/** `<base>/<path>`, tolerant of a trailing slash on the base and a missing
 *  leading one on the path. */
function endpoint(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

export async function askClef(
  state: unknown,
  questions: Record<string, ClefQuestion>,
  opts: ClefOptions,
): Promise<{ answers: Record<string, ClefAnswer>; ms: number }> {
  const f = opts.fetchImpl ?? fetch;
  const t0 = Date.now();
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;
  const res = await f(endpoint(opts.baseUrl, opts.path ?? CLEF_PATH_DEFAULT), {
    method: "POST",
    headers,
    body: JSON.stringify({ model: opts.model ?? CLEF_MODEL_DEFAULT, state, questions }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
  });
  if (!res.ok) throw new Error(`clef HTTP ${res.status}`);
  const json = (await res.json()) as { answers?: Record<string, ClefAnswer> };
  if (!json.answers) throw new Error("clef reply has no answers");
  return { answers: json.answers, ms: Date.now() - t0 };
}

export async function askClefOrNull(
  ...args: Parameters<typeof askClef>
): Promise<Awaited<ReturnType<typeof askClef>> | null> {
  try {
    return await askClef(...args);
  } catch {
    return null;
  }
}

export interface ClefSettings extends ClefOptions {
  readonly path: string;
  readonly model: string;
}

/**
 * NLM_CLEF_BASE_URL / NLM_CLEF_PATH / NLM_CLEF_MODEL / NLM_CLEF_API_KEY.
 * Null when no base is configured — a caller treats that as "Clef is not
 * available here" rather than guessing at a port. The base is the only
 * required one: a direct host needs no key, and the path/model defaults are
 * the gateway shape the fleet has always used (so pointing NLM_CLEF_BASE_URL
 * at the gateway alone is a valid config).
 */
export function clefSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): ClefSettings | null {
  const baseUrl = env["NLM_CLEF_BASE_URL"]?.trim();
  if (!baseUrl) return null;
  const path = env["NLM_CLEF_PATH"]?.trim() || CLEF_PATH_DEFAULT;
  const model = env["NLM_CLEF_MODEL"]?.trim() || CLEF_MODEL_DEFAULT;
  const apiKey = env["NLM_CLEF_API_KEY"]?.trim();
  return { baseUrl, path, model, ...(apiKey ? { apiKey } : {}) };
}
