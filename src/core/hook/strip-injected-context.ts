/**
 * Removes NLM's own injected recall pointer block from a transcript before it
 * is classified. The recall hook prepends a "Possibly-relevant prior sessions"
 * / "Known facts about top entities" block (see pointer-block.ts) to the user
 * prompt every turn; that block lands in the stored transcript and the
 * classifier then extracted "facts" FROM it — a feedback loop that produced
 * garbage facts like `acme-app owner: user` sourced from the recall block
 * itself (NLM #325).
 *
 * The block is bounded: it starts at one of the two known headers and always
 * ends with the `NLM tools:` footer (formatPointerBlock emits it
 * unconditionally). We strip header→footer inclusive. A header with no
 * following footer is left in place — that signals truncated/real content, and
 * dropping to end-of-text could eat the user's actual message.
 */

/**
 * The recall pointer block's marker strings — the single source of truth.
 * The shipped pi recall hook (nlm/index.js) carries its own copy of these in
 * its self-contained formatPointerBlock; recall-marker-contract.test.ts asserts
 * the hook still emits these so marker drift can't silently reopen the loop.
 */
export const BLOCK_HEADERS = [
  "## Possibly-relevant prior sessions (nlm-memory)",
  "## Known facts about top entities",
];

export const FOOTER_PREFIX = "NLM tools:";

export function stripInjectedContext(text: string): string {
  if (!text.includes(FOOTER_PREFIX)) return text;

  const lines = text.split("\n");
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (BLOCK_HEADERS.includes(line.trim())) {
      const footerIdx = findFooter(lines, i + 1);
      if (footerIdx !== -1) {
        i = footerIdx; // skip header..footer inclusive
        continue;
      }
    }
    kept.push(line);
  }
  return collapseBlankRuns(kept).join("\n");
}

function findFooter(lines: ReadonlyArray<string>, from: number): number {
  for (let i = from; i < lines.length; i++) {
    if ((lines[i] ?? "").startsWith(FOOTER_PREFIX)) return i;
  }
  return -1;
}

/** Collapse 3+ consecutive blank lines (left by removal) down to one. */
function collapseBlankRuns(lines: ReadonlyArray<string>): string[] {
  const out: string[] = [];
  let blanks = 0;
  for (const line of lines) {
    if (line.trim() === "") {
      blanks += 1;
      if (blanks > 1) continue;
    } else {
      blanks = 0;
    }
    out.push(line);
  }
  while (out.length > 0 && (out[0] ?? "").trim() === "") out.shift();
  while (out.length > 0 && (out[out.length - 1] ?? "").trim() === "") out.pop();
  return out;
}
