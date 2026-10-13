export type ClefQuestion =
  | { type: "noul"; instructions: string; criteria?: { true: string; false: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };

export type ClefAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: "score"; score: number; confidence: number; probabilities: Record<string, number>; legend: Record<string, string> };

export interface ClefOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

export async function askClef(
  state: unknown,
  questions: Record<string, ClefQuestion>,
  opts: ClefOptions,
): Promise<{ answers: Record<string, ClefAnswer>; ms: number }> {
  const f = opts.fetchImpl ?? fetch;
  const t0 = Date.now();
  const res = await f(`${opts.baseUrl}/clef/v1/systemone`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
    body: JSON.stringify({ model: opts.model ?? "clef-oQ4e", state, questions }),
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
