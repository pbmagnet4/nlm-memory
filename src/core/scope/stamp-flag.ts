export function scopeStampEnabled(): boolean {
  return process.env["NLM_SCOPE_STAMP"] === "1";
}
