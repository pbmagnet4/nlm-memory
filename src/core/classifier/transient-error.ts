import { LLMUnreachableError } from "@ports/llm-client.js";
import { TimeoutError } from "@core/util/with-timeout.js";

const NETWORK_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"]);

function codeOf(e: unknown): string | undefined {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

/**
 * True for infrastructure failures (outage, reset, DNS, gateway 5xx, timeout):
 * the transcript is fine and a later attempt can succeed, so these must not
 * count as a strike against it. A 4xx from the server is a request problem, and
 * bad model output (non-JSON, schema) is a quality failure; both stay strikes.
 */
export function isTransientLLMError(e: unknown): boolean {
  if (e instanceof TimeoutError) return true;
  if (e instanceof LLMUnreachableError) return !/status 4\d\d/.test(e.message);
  const code = codeOf(e);
  if (code !== undefined && NETWORK_CODES.has(code)) return true;
  const cause = (e as { cause?: unknown } | null)?.cause;
  return cause !== undefined && cause !== e && isTransientLLMError(cause);
}
