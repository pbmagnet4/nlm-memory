/**
 * Voice backfill readers (T2438 piece C, design §C4): the file side of
 * `nlm voice backfill`, with no daemon, no store and no clock of its own.
 *
 * NLM never calls NocoDB, a CMS or a social API (scope boundary §C5): the
 * consumer exports files, these readers turn them into records and count what
 * they could not read. Counts, never text — an export of someone's published
 * writing must not end up in a terminal scrollback through an error message.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { WritingSampleOutcome, WritingSampleSource } from "@ports/writing-sample-store.js";

/** One row a reader can store: everything the endpoint needs except the voice. */
export interface VoiceBackfillRecord {
  readonly channel: string;
  readonly text: string;
  /** URL or upstream record id; null when the source carried neither. */
  readonly sourceRef: string | null;
  readonly source: WritingSampleSource;
  readonly outcome: WritingSampleOutcome;
  /** What the text replied to (an email subject line, typically). Never embedded. */
  readonly context: string | null;
  readonly ts: string;
}

export interface BackfillReadResult {
  readonly records: ReadonlyArray<VoiceBackfillRecord>;
  /** A file with nothing in it: nothing to store, nothing wrong with it. */
  readonly skipped: number;
  /** Unreadable or malformed input, plus (in the runner) rows the endpoint refused. */
  readonly rejected: number;
}

export interface BackfillReaderOptions {
  /** Clock for a source that carries no date of its own. */
  readonly now?: () => string;
}

type Timestamp = { readonly ok: true; readonly ts: string } | { readonly ok: false };

function readTimestamp(raw: unknown, now: () => string): Timestamp {
  if (raw === undefined || raw === null) return { ok: true, ts: now() };
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? { ok: false } : { ok: true, ts: raw.toISOString() };
  if (typeof raw !== "string") return { ok: false };
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? { ok: false } : { ok: true, ts: new Date(parsed).toISOString() };
}

function markdownFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...markdownFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".md")) found.push(full);
  }
  return found.sort();
}

const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/;

/**
 * `markdown-dir`: frontmatter `url` (or `slug`) is the provenance, `date` (or
 * `published_at`) is when it was written, and the body without the frontmatter
 * is the text. The channel cannot come from a blog export, so the caller
 * supplies it.
 */
export function readMarkdownDir(
  dir: string,
  opts: BackfillReaderOptions & { channel: string },
): BackfillReadResult {
  const now = opts.now ?? (() => new Date().toISOString());
  const records: VoiceBackfillRecord[] = [];
  let skipped = 0;
  let rejected = 0;

  for (const file of markdownFiles(dir)) {
    const raw = readFileSync(file, "utf8");
    const match = FRONTMATTER.exec(raw);
    let frontmatter: Record<string, unknown> = {};
    let body = raw;
    if (match) {
      body = raw.slice(match[0].length);
      let parsed: unknown;
      try {
        parsed = parseYaml(match[1] ?? "");
      } catch {
        rejected += 1;
        continue;
      }
      if (parsed === null) parsed = {};
      if (typeof parsed !== "object" || Array.isArray(parsed)) {
        rejected += 1;
        continue;
      }
      frontmatter = parsed as Record<string, unknown>;
    }

    const text = body.trim();
    if (text === "") {
      skipped += 1;
      continue;
    }
    const ref = frontmatter["url"] ?? frontmatter["slug"];
    if (ref !== undefined && ref !== null && typeof ref !== "string") {
      rejected += 1;
      continue;
    }
    const stamp = readTimestamp(frontmatter["date"] ?? frontmatter["published_at"], now);
    if (!stamp.ok) {
      rejected += 1;
      continue;
    }

    records.push({
      channel: opts.channel,
      text,
      sourceRef: typeof ref === "string" && ref !== "" ? ref : null,
      source: "published",
      outcome: "published",
      context: null,
      ts: stamp.ts,
    });
  }

  return { records, skipped, rejected };
}

/**
 * `jsonl`: one object per line, as written by the Whtnxt Agent export (piece E).
 * `source`, `outcome` and `context` are optional so an email import can land as
 * `source: import, outcome: approved` with its subject line as context; a line
 * carrying an invalid one is rejected rather than silently relabelled.
 */
const jsonlLine = z.object({
  channel: z.string(),
  text: z.string(),
  url: z.string().nullish(),
  ref: z.string().nullish(),
  published_at: z.string().nullish(),
  source: z.enum(["published", "approved", "import", "onboarding"]).optional(),
  outcome: z.enum(["published", "approved", "rejected"]).optional(),
  context: z.string().nullish(),
});

export function readJsonl(path: string, opts: BackfillReaderOptions = {}): BackfillReadResult {
  const now = opts.now ?? (() => new Date().toISOString());
  const records: VoiceBackfillRecord[] = [];
  let rejected = 0;

  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      rejected += 1;
      continue;
    }
    const check = jsonlLine.safeParse(parsed);
    if (!check.success) {
      rejected += 1;
      continue;
    }
    const row = check.data;
    const text = row.text.trim();
    const channel = row.channel.trim();
    if (text === "" || channel === "") {
      rejected += 1;
      continue;
    }
    const stamp = readTimestamp(row.published_at, now);
    if (!stamp.ok) {
      rejected += 1;
      continue;
    }

    records.push({
      channel,
      text,
      sourceRef: row.url || row.ref || null,
      source: row.source ?? "published",
      outcome: row.outcome ?? "published",
      context: row.context || null,
      ts: stamp.ts,
    });
  }

  return { records, skipped: 0, rejected };
}
