/**
 * One OpenAI-compatible chat call, shared by the replay eval and the Stage A
 * judge. Extracted from recall-impact-replay.ts, which is the only eval path
 * that ever sent max_tokens, stream: false, and reasoning_effort; judge.ts's
 * streamChatOnce sends neither max_tokens nor reasoning_effort, so a
 * reasoning model there burns its budget on hidden tokens and returns a 200
 * with empty content.
 *
 * Retries once on any failure (non-2xx, transport error, or empty content) —
 * ported from recall-impact-replay.ts's callChat, which wrapped every
 * generation and judge call in this same one-retry policy to absorb queuing
 * hiccups on the shared local inference server. That retry produced the
 * published 0.881 causal-replay result; dropping it here would silently
 * change the eval's failure rate.
 */

export interface ChatOptions {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey?: string;
  readonly temperature: number;
  readonly maxTokens: number;
  readonly reasoningEffort?: string;
  readonly timeoutMs?: number;
}

async function chatOnceAttempt(
  opts: ChatOptions,
  system: string,
  user: string,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 180_000);
  try {
    const res = await fetch(`${opts.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: opts.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: opts.temperature,
        max_tokens: opts.maxTokens,
        stream: false,
        ...(opts.reasoningEffort ? { reasoning_effort: opts.reasoningEffort } : {}),
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`chat HTTP ${res.status}: ${body.slice(0, 300)}`);
    }
    const json = (await res.json()) as {
      choices?: ReadonlyArray<{ message?: { content?: string } }>;
    };
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim().length === 0) {
      throw new Error(
        "chat returned empty content (a reasoning model may have spent max_tokens on hidden tokens)",
      );
    }
    return content;
  } finally {
    clearTimeout(timer);
  }
}

export async function chatOnce(
  opts: ChatOptions,
  system: string,
  user: string,
): Promise<string> {
  try {
    return await chatOnceAttempt(opts, system, user);
  } catch {
    return await chatOnceAttempt(opts, system, user);
  }
}
