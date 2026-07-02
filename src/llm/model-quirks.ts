/** Qwen 3.5+ models default to extended chain-of-thought, which blows the
 * classify timeout. Disable thinking for them; non-thinking models like
 * qwen3:4b-instruct are unaffected. */
export function classifierNeedsThinkDisabled(model: string): boolean {
  return /qwen3\.5/i.test(model);
}
