/**
 * `nlm voice backfill` runner (T2438 piece C, design §C4): readers to POSTs.
 *
 * It posts rather than writing the store itself so the daemon keeps the only
 * copy of the tenancy, install-scope and embedder decisions — the importer is
 * a client, exactly like `nlm voice-signal`. One POST at a time: an import of
 * a few thousand posts must not outrun the prose embedder that each new row
 * triggers behind the response.
 */

import { readJsonl, readMarkdownDir, type BackfillReadResult, type VoiceBackfillRecord } from "./backfill-readers.js";
import type { WritingSampleOutcome, WritingSampleSource } from "@ports/writing-sample-store.js";

/** The body of POST /api/voice/sample, in the field names §C1 defines. */
export interface VoiceSamplePayload {
  readonly voice: string;
  readonly channel: string;
  readonly text: string;
  readonly source: WritingSampleSource;
  readonly outcome: WritingSampleOutcome;
  readonly source_ref: string | null;
  readonly context: string | null;
  readonly ts: string;
}

/** Everything the operator sees: `rejected` covers reader failures and refusals alike. */
export interface VoiceBackfillCounts {
  read: number;
  stored: number;
  skipped: number;
  rejected: number;
}

export interface VoiceBackfillDeps {
  /** "markdown-dir" | "jsonl", checked below: it arrives from argv. */
  readonly format: string;
  readonly path: string;
  readonly voice: string;
  readonly channel?: string;
  readonly dryRun?: boolean;
  readonly post: (payload: VoiceSamplePayload) => Promise<{ status: number }>;
  readonly now?: () => string;
}

function samplePayload(voice: string, record: VoiceBackfillRecord): VoiceSamplePayload {
  return {
    voice,
    channel: record.channel,
    text: record.text,
    source: record.source,
    outcome: record.outcome,
    source_ref: record.sourceRef,
    context: record.context,
    ts: record.ts,
  };
}

export async function runVoiceBackfill(deps: VoiceBackfillDeps): Promise<VoiceBackfillCounts> {
  const now = deps.now ?? (() => new Date().toISOString());

  // The format arrives from argv, so this is the boundary that checks it.
  let read: BackfillReadResult;
  if (deps.format === "markdown-dir") {
    if (!deps.channel) {
      throw new Error("voice backfill markdown-dir needs --channel: a directory of exported files cannot name its own channel");
    }
    read = readMarkdownDir(deps.path, { channel: deps.channel, now });
  } else if (deps.format === "jsonl") {
    read = readJsonl(deps.path, { now });
  } else {
    throw new Error(`unknown voice backfill format "${deps.format}" (markdown-dir | jsonl)`);
  }

  const counts: VoiceBackfillCounts = {
    read: read.records.length,
    stored: 0,
    skipped: read.skipped,
    rejected: read.rejected,
  };
  if (deps.dryRun) return counts;

  for (const record of read.records) {
    const { status } = await deps.post(samplePayload(deps.voice, record));
    if (status === 201) counts.stored += 1;
    else if (status === 200) counts.skipped += 1;
    else counts.rejected += 1;
  }
  return counts;
}

export function formatVoiceBackfillCounts(counts: VoiceBackfillCounts): string {
  return JSON.stringify(counts);
}
