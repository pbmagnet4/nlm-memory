/**
 * Voice producer payload (T2438 piece C, design §C3).
 *
 * The CLI's job is to turn flags into exactly the body §C1 defines, so the
 * wire shape is asserted here rather than by spawning the binary; the spawn
 * tests live in tests/integration/voice-cli.test.ts.
 */

import { describe, expect, it } from "vitest";
import {
  buildVoiceSignalPayload,
  formatVoiceSignalResult,
} from "../../../../src/core/voice/voice-signal.js";

const NOW = "2026-11-23T12:00:00.000Z";
const now = () => NOW;

describe("buildVoiceSignalPayload", () => {
  it("sends the flags the operator passed, on the caller's clock", () => {
    expect(
      buildVoiceSignalPayload({
        voice: "edward",
        channel: "linkedin",
        text: "Plain words, one idea.",
        url: "https://whtnxt.com/two-files",
        outcome: "approved",
        draftId: "draft-7",
        now,
      }),
    ).toEqual({
      voice: "edward",
      channel: "linkedin",
      text: "Plain words, one idea.",
      outcome: "approved",
      source_ref: "https://whtnxt.com/two-files",
      draft_id: "draft-7",
      ts: NOW,
    });
  });

  it("defaults the outcome to published and omits the flags that were not passed", () => {
    expect(
      buildVoiceSignalPayload({ voice: "edward", channel: "email", text: "Lead with the ask.", now }),
    ).toEqual({ voice: "edward", channel: "email", text: "Lead with the ask.", outcome: "published", ts: NOW });
  });

  it("trims the text, so a file's trailing newline never reaches the corpus", () => {
    expect(
      buildVoiceSignalPayload({ voice: "e", channel: "linkedin", text: "  A post.\n\n", now }).text,
    ).toBe("A post.");
  });

  it("posts no key the endpoint would have to guess about", () => {
    const payload = buildVoiceSignalPayload({ voice: "edward", channel: "email", text: "x", now });
    expect(Object.keys(payload).sort()).toEqual(["channel", "outcome", "text", "ts", "voice"]);
  });
});

describe("formatVoiceSignalResult", () => {
  it("says which of the two outcomes the daemon reported", () => {
    expect(formatVoiceSignalResult({ id: "ab12", skipped: false })).toBe("voice-signal: stored id=ab12");
    expect(formatVoiceSignalResult({ id: "ab12", skipped: true })).toBe("voice-signal: already stored id=ab12");
  });
});
