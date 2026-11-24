/**
 * Voice retire (T2438): the body of POST /api/voice/retire, and the runner
 * behind `nlm voice retire`.
 *
 * Automated-email and placeholder imports landed in the corpus as the
 * person's own writing; this is the delete path. The CLI still posts through
 * the daemon rather than opening the store — tenancy and install scope
 * belong to the daemon, exactly as for the two producer commands. Batches of
 * 500 keep the endpoint's IN() list small and leave the daemon room to
 * answer ordinary requests between batches.
 */

import { readFileSync } from "node:fs";
import { z } from "zod";

/** Most a single POST may retire. */
export const MAX_RETIRE_REFS = 1000;

/** Refs per POST on the CLI lane — under the endpoint cap, with room to spare. */
export const RETIRE_BATCH_SIZE = 500;

const bodySchema = z.object({
  refs: z.array(z.string()).min(1).max(MAX_RETIRE_REFS),
});

export type VoiceRetireParse =
  | { readonly ok: true; readonly refs: readonly string[] }
  | { readonly ok: false; readonly error: string };

/** Validate and normalise a retire body: trimmed refs, none of them blank. */
export function parseVoiceRetireBody(body: unknown): VoiceRetireParse {
  const check = bodySchema.safeParse(body);
  if (!check.success) {
    return {
      ok: false,
      error: check.error.issues
        .map((issue) => `${issue.path.length ? issue.path.join(".") : "body"}: ${issue.message}`)
        .join("; "),
    };
  }
  const refs = check.data.refs.map((ref) => ref.trim());
  if (refs.some((ref) => ref === "")) return { ok: false, error: "refs must be non-empty strings" };
  return { ok: true, refs };
}

/** Read one source_ref per line; blank and whitespace-only lines are ignored. */
export function readVoiceRefsFile(path: string): string[] {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

export interface VoiceRetireCounts {
  requested: number;
  retired: number;
}

export interface VoiceRetireBatchResult {
  /** 0 means the batch never reached a socket. */
  readonly status: number;
  readonly retired?: number;
  /** One already-bounded line naming why a non-200 refused the batch. */
  readonly reason?: string;
}

export interface VoiceRetireDeps {
  readonly refs: readonly string[];
  readonly dryRun?: boolean;
  readonly post: (batch: readonly string[]) => Promise<VoiceRetireBatchResult>;
}

/**
 * POST the refs in batches and add up what the daemon retired. Unlike the
 * best-effort producers, a refused or unreachable batch aborts: retirement
 * is a deliberate operator action, and quietly doing half of it is the one
 * outcome that must not look like success.
 */
export async function runVoiceRetire(deps: VoiceRetireDeps): Promise<VoiceRetireCounts> {
  const counts: VoiceRetireCounts = { requested: deps.refs.length, retired: 0 };
  if (deps.dryRun) return counts;
  for (let lo = 0; lo < deps.refs.length; lo += RETIRE_BATCH_SIZE) {
    const batch = deps.refs.slice(lo, lo + RETIRE_BATCH_SIZE);
    const { status, retired, reason } = await deps.post(batch);
    if (status !== 200) {
      if (status === 0) throw new Error(reason ?? "daemon unreachable");
      throw new Error(`daemon returned ${status}${reason ? ` ${reason}` : ""}`);
    }
    counts.retired += retired ?? 0;
  }
  return counts;
}

export function formatVoiceRetireCounts(counts: VoiceRetireCounts): string {
  return JSON.stringify(counts);
}
