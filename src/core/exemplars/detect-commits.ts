/**
 * Detect git commit sha(s) in a session transcript, deterministically.
 *
 * Matches the `[branch sha] message` line git prints on commit (including
 * `(root-commit)` and `detached HEAD` variants). Requires >= 7 hex chars so
 * bracketed dates / short tokens don't false-positive. A false positive is
 * harmless downstream: `git show` on a non-sha just fails and is skipped.
 */
const COMMIT_LINE = /\[(?:[^\]]*\s)?([0-9a-f]{7,40})\]/g;

export function detectCommitShas(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(COMMIT_LINE)) {
    const sha = m[1];
    if (sha && !seen.has(sha)) {
      seen.add(sha);
      out.push(sha);
    }
  }
  return out;
}
