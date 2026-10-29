import { createHash } from "node:crypto";

export const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export const clean = (s: string) => s.replace(/(?:sk|ghp|gho)_[A-Za-z0-9_-]{12,}/g, "[REDACTED]")
  .replace(/(?:Bearer\s+)[A-Za-z0-9_.-]{16,}/gi, "Bearer [REDACTED]")
  .replace(/((?:password|api[_ -]?key|access[_ -]?token|secret)\s*[=:]\s*)[^\s,;]{8,}/gi, "$1[REDACTED]");
export function userEvidence(body: string): string[] {
  const turns = [...body.matchAll(/\[(?:user|human)\]\s*([\s\S]*?)(?=\n\n\[(?:user|human|assistant|system|tool)\]|\[tool_result:|$)/gi)]
    .map((m) => m[1]!.trim()).filter((s) => !/^#?\s*(?:AGENTS\.md|CLAUDE\.md)|^<environment_context>|^<INSTRUCTIONS>/i.test(s));
  return turns.slice(0, 8).map((s) => clean(s.slice(0, 400)));
}
export function context(body: string, quote: string | null, subject: string): string {
  const at = quote ? body.indexOf(quote) : body.toLowerCase().indexOf(subject.toLowerCase());
  return clean(at < 0 ? body.slice(-1500) : body.slice(Math.max(0, at - 350), at + (quote?.length ?? subject.length) + 650));
}
