/**
 * Tokenizer mirrors recall.py:_TOKEN_RE. Identical regex, lowercase normalize.
 * Pure function. The keyword scorer's parity with the Python implementation
 * starts here.
 */

const TOKEN_PATTERN = /[A-Za-z0-9][A-Za-z0-9_.-]*/g;

export function tokenize(text: string | null | undefined): ReadonlyArray<string> {
  if (!text) return [];
  const matches = text.match(TOKEN_PATTERN);
  if (!matches) return [];
  return matches.map((t) => t.toLowerCase());
}

export function tokenSet(text: string | null | undefined): Set<string> {
  return new Set(tokenize(text));
}
