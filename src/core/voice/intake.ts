/**
 * Voice intake validation (T2438 piece C, design §C1): the body of
 * POST /api/voice/sample turned into a WritingSampleInput.
 *
 * The endpoint is a boundary, so everything a caller can get wrong is checked
 * here and nothing else is: no scrubbing in phase 1 (both intake paths carry
 * text the person already published or approved), and no `install_scope` —
 * the store stamps that itself, which is why the port's input has no field for
 * it.
 */

import { z } from "zod";
import type {
  WritingSampleInput,
  WritingSampleOutcome,
  WritingSampleSource,
} from "@ports/writing-sample-store.js";

/** A post longer than this is a paste of a whole article, not a voice sample. */
export const MAX_VOICE_SAMPLE_TEXT_CHARS = 20_000;

/**
 * What a caller may omit. `source` defaults from `outcome` so a producer only
 * has to know what happened to the text; an explicit `source` (the email
 * import sends `import`) always wins.
 */
const SOURCE_BY_OUTCOME: Record<WritingSampleOutcome, WritingSampleSource> = {
  published: "published",
  approved: "approved",
  rejected: "approved",
  // Not published and not thrown away, so it is an approved draft awaiting its
  // verdict — the same lane a rejected sample shares, and recall prefers the
  // higher source when the same text later ships.
  pending_review: "approved",
};

const bodySchema = z.object({
  voice: z.string(),
  channel: z.string(),
  audience: z.string().nullish(),
  text: z.string(),
  outcome: z.enum(["published", "approved", "rejected", "pending_review"]),
  source: z.enum(["published", "approved", "import", "onboarding"]).optional(),
  source_ref: z.string().nullish(),
  context: z.string().nullish(),
  draft_id: z.string().nullish(),
  session_id: z.string().nullish(),
  ts: z.string().optional(),
});

export type VoiceIntakeParse =
  | { readonly ok: true; readonly input: WritingSampleInput }
  | { readonly ok: false; readonly error: string };

function fieldErrors(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length ? issue.path.join(".") : "body"}: ${issue.message}`)
    .join("; ");
}

/** `now` is the ts of a sample whose producer knew none — the daemon's clock. */
export function toWritingSampleInput(body: unknown, now: () => string): VoiceIntakeParse {
  const check = bodySchema.safeParse(body);
  if (!check.success) return { ok: false, error: fieldErrors(check.error) };
  const b = check.data;

  const voice = b.voice.trim();
  if (voice === "") return { ok: false, error: "voice is required" };
  const channel = b.channel.trim();
  if (channel === "") return { ok: false, error: "channel is required" };
  const text = b.text.trim();
  if (text === "") return { ok: false, error: "text is required" };
  if (text.length > MAX_VOICE_SAMPLE_TEXT_CHARS) {
    return { ok: false, error: `text exceeds ${MAX_VOICE_SAMPLE_TEXT_CHARS} characters` };
  }
  if (b.ts !== undefined && Number.isNaN(Date.parse(b.ts))) {
    return { ok: false, error: "ts must be an ISO-8601 date" };
  }

  return {
    ok: true,
    input: {
      voice,
      channel,
      ...(b.audience ? { audience: b.audience } : {}),
      source: b.source ?? SOURCE_BY_OUTCOME[b.outcome],
      ...(b.source_ref ? { sourceRef: b.source_ref } : {}),
      text,
      ...(b.context ? { context: b.context } : {}),
      outcome: b.outcome,
      ...(b.draft_id ? { draftId: b.draft_id } : {}),
      ...(b.session_id ? { sessionId: b.session_id } : {}),
      ts: b.ts ?? now(),
    },
  };
}
