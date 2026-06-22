/**
 * Unified-diff parsing helpers shared by the exemplar extractor (path a) and
 * the code-signal producer. Pure string functions — no I/O.
 */

export interface DiffHunk {
  readonly file: string;
  readonly hunkHeader: string;
  readonly body: string;
}

/** Extract a git hunk header funcname: `@@ ... @@ funcname` */
export function parseFuncname(hunkHeader: string): string | null {
  const m = hunkHeader.match(/@@ [^@]+ @@ (.+)/);
  return m?.[1]?.trim() ?? null;
}

/** Detect likely language from file extension. */
export function detectLang(filePath: string): string | null {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "ts", tsx: "ts", js: "js", jsx: "js", mjs: "js",
    py: "py", go: "go", rb: "rb", rs: "rs", java: "java",
    c: "c", cpp: "cpp", cs: "cs", swift: "swift", kt: "kt",
    sh: "sh", bash: "sh", zsh: "sh",
  };
  return map[ext] ?? null;
}

/**
 * Parse a unified diff into individual hunks. Returns (file, hunkHeader, body) triples.
 */
export function parseHunks(diff: string): DiffHunk[] {
  const result: DiffHunk[] = [];
  let currentFile = "";
  let currentHeader = "";
  let bodyLines: string[] = [];

  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) {
      currentFile = line.slice(6);
    } else if (line.startsWith("@@ ")) {
      if (currentHeader && bodyLines.length > 0) {
        result.push({ file: currentFile, hunkHeader: currentHeader, body: bodyLines.join("\n") });
      }
      currentHeader = line;
      bodyLines = [];
    } else if (currentHeader && (line.startsWith("+") || line.startsWith("-") || line.startsWith(" "))) {
      bodyLines.push(line);
    }
  }
  if (currentHeader && bodyLines.length > 0) {
    result.push({ file: currentFile, hunkHeader: currentHeader, body: bodyLines.join("\n") });
  }
  return result;
}

/**
 * Extract the added/changed lines from a hunk body (strip context and removed lines).
 */
export function extractAddedLines(hunkBody: string): string {
  return hunkBody
    .split("\n")
    .filter((l) => l.startsWith("+"))
    .map((l) => l.slice(1))
    .join("\n");
}

/** Pick the hunk with the most non-blank added lines (most representative). */
export function selectLargestHunk(hunks: readonly DiffHunk[]): DiffHunk | null {
  let best: DiffHunk | undefined;
  let bestCount = 0;
  for (const h of hunks) {
    const added = extractAddedLines(h.body);
    const count = added.split("\n").filter((l) => l.trim()).length;
    if (count > bestCount) { bestCount = count; best = h; }
  }
  return best ?? null;
}
