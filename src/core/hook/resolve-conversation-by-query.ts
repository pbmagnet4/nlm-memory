/**
 * Resolve which conversation triggered a recall pull, by scanning the N
 * most-recently-modified transcript JSONL files across the local runtimes'
 * transcript stores for the exact query string.
 *
 * When an agent calls a recall tool, the runtime has already written the
 * tool_use block (containing the query string) to its transcript before the
 * MCP handler runs. Scanning the tail of the newest transcripts gives a
 * deterministic, cheap join between a pull log entry and its source
 * conversation, without requiring the agent to pass conversation_id explicitly.
 *
 * Claude Code conversations resolve to their bare transcript id; other
 * runtimes resolve to `<runtime>:<id>` so their ids can't collide.
 *
 * Fail-open: any I/O error returns null so the recall path never breaks.
 */

import { closeSync, fstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";

const MIN_QUERY_LEN = 12;
const TAIL_BYTES = 64 * 1024;
const MAX_CANDIDATES = 5;

export interface ResolveByQueryOpts {
  /** Scan only this directory, as Claude Code transcripts. */
  readonly rootDir?: string;
}

interface TranscriptRoot {
  readonly dir: string;
  /** Conversation id for a transcript file in this root. */
  readonly idOf: (path: string, stem: string) => string;
}

function defaultRoots(): TranscriptRoot[] {
  const home = homedir();
  const dataHome = process.env["XDG_DATA_HOME"] || join(home, ".local", "share");
  return [
    {
      dir: process.env["NLM_CLAUDE_PROJECTS_ROOT"] ?? join(home, ".claude", "projects"),
      idOf: (_path, stem) => stem,
    },
    { dir: join(home, ".codex", "sessions"), idOf: (_path, stem) => `codex:${stem}` },
    { dir: join(home, ".pi", "agent", "sessions"), idOf: (_path, stem) => `pi:${stem}` },
    // Muse names every transcript session.jsonl; the session is its directory.
    { dir: join(dataHome, "muse", "sessions"), idOf: (path) => `muse:${basename(dirname(path))}` },
  ];
}

function tailRead(path: string, maxBytes: number): string {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const start = size > maxBytes ? size - maxBytes : 0;
    const len = size - start;
    if (len <= 0) return "";
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, start);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function collectJsonlFiles(dir: string): Array<{ path: string; stem: string; mtimeMs: number }> {
  const results: Array<{ path: string; stem: string; mtimeMs: number }> = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...collectJsonlFiles(full));
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try {
          const st = statSync(full);
          results.push({ path: full, stem: entry.name.slice(0, -".jsonl".length), mtimeMs: st.mtimeMs });
        } catch {
          // skip files that vanish or are unreadable
        }
      }
    }
  } catch {
    // skip unreadable directories
  }
  return results;
}

/**
 * Scan the N most-recently-modified JSONL transcripts under rootDir for the
 * exact query string. Returns the conversation id (filename stem without
 * .jsonl) of the first match, or null if none found.
 *
 * Short queries (< MIN_QUERY_LEN chars) are always skipped: they are too
 * ambiguous to produce a reliable match.
 */
export function resolveConversationByQuery(query: string, opts?: ResolveByQueryOpts): string | null {
  try {
    if (query.length < MIN_QUERY_LEN) return null;
    const roots = opts?.rootDir ? [{ dir: opts.rootDir, idOf: (_p: string, stem: string) => stem }] : defaultRoots();
    const files = roots
      .flatMap((root) => collectJsonlFiles(root.dir).map((f) => ({ ...f, root })))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, MAX_CANDIDATES);
    for (const { path, stem, root } of files) {
      try {
        const tail = tailRead(path, TAIL_BYTES);
        if (tail.includes(query)) return root.idOf(path, stem);
      } catch {
        // skip unreadable or vanished files
      }
    }
    return null;
  } catch {
    return null;
  }
}
