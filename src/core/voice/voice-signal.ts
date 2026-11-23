/**
 * `nlm voice-signal` payload (T2438 piece C, design §C3): what the producer
 * posts to /api/voice/sample.
 *
 * Deliberately the endpoint's body and nothing more — the daemon owns
 * tenancy, install scope and the id, so a producer cannot smuggle any of them
 * in through a flag.
 */

import type { WritingSampleOutcome } from "@ports/writing-sample-store.js";

export interface VoiceSignalPayload {
  readonly voice: string;
  readonly channel: string;
  readonly text: string;
  readonly outcome: WritingSampleOutcome;
  readonly source_ref?: string;
  readonly draft_id?: string;
  readonly ts: string;
}

export interface BuildVoiceSignalArgs {
  readonly voice: string;
  readonly channel: string;
  readonly text: string;
  readonly url?: string;
  readonly outcome?: WritingSampleOutcome;
  readonly draftId?: string;
  readonly now?: () => string;
}

export function buildVoiceSignalPayload(args: BuildVoiceSignalArgs): VoiceSignalPayload {
  const now = args.now ?? (() => new Date().toISOString());
  return {
    voice: args.voice,
    channel: args.channel,
    // A file always ends in a newline an argv string does not; the store keeps
    // the writing, not the editor's trailing byte.
    text: args.text.trim(),
    outcome: args.outcome ?? "published",
    ...(args.url ? { source_ref: args.url } : {}),
    ...(args.draftId ? { draft_id: args.draftId } : {}),
    ts: now(),
  };
}

export function formatVoiceSignalResult(result: { id: string; skipped: boolean }): string {
  return `voice-signal: ${result.skipped ? "already stored" : "stored"} id=${result.id}`;
}

/**
 * `--outcome` arrives as argv text, and the endpoint is the validator. Checking
 * it here too costs one line and saves a round trip that would come back as a
 * JSON blob in a terminal.
 */
const VOICE_OUTCOMES = ["published", "approved", "rejected", "pending_review"] as const;

export function parseVoiceOutcome(raw: string): WritingSampleOutcome | undefined {
  return VOICE_OUTCOMES.find((outcome) => outcome === raw);
}
