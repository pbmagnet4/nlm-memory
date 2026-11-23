import { z } from "zod";

/**
 * Contract for a `<voice>.yaml` rules file read from NLM_VOICE_RULES_DIR
 * (design: docs/superpowers/specs/2026-11-23-voice-memory-phase1-design.md, §B).
 * NLM ships this schema; schemas/voice-rules.schema.json is generated from it
 * by scripts/gen-voice-rules-schema.ts and checked by a test that regenerates
 * and compares. The consumer side (Whtnxt Agent) validates against the
 * generated JSON Schema.
 */

/** Channel- and audience-level overrides share one shape (design §B). */
const rulesOverrides = z
  .object({
    rules: z.array(z.string()).optional(),
    banned_phrases: z.array(z.string()).optional(),
    max_chars: z.number().int().positive().optional(),
  })
  .strict();

export const voiceRulesFileSchema = z
  .object({
    voice: z.string(),
    rules: z.array(z.string()).optional(),
    banned_phrases: z.array(z.string()).optional(),
    max_chars: z.number().int().positive().optional(),
    channels: z.record(z.string(), rulesOverrides).optional(),
    audiences: z.record(z.string(), rulesOverrides).optional(),
  })
  .strict();

export type VoiceRulesFile = z.infer<typeof voiceRulesFileSchema>;
export type VoiceRulesOverrides = z.infer<typeof rulesOverrides>;
