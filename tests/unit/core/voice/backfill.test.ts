/**
 * `nlm voice backfill` runner (T2438 piece C, design §C4): readers in, one
 * sequential POST per record out, counts back. The runner is injected with a
 * `post`, so this file proves the two things the operator depends on: a
 * --dry-run touches nothing, and the output can never leak the text.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  formatVoiceBackfillCounts,
  runVoiceBackfill,
  type VoiceSamplePayload,
} from "../../../../src/core/voice/backfill.js";

const VOICE = "edward";
const NOW = "2026-11-23T12:00:00.000Z";
const now = () => NOW;
const MD = resolve("tests/fixtures/voice/md");
const JSONL = resolve("tests/fixtures/voice/posts.jsonl");

function recordPost(status: number | ((payload: VoiceSamplePayload) => number)) {
  const calls: VoiceSamplePayload[] = [];
  const post = async (payload: VoiceSamplePayload) => {
    calls.push(payload);
    return { status: typeof status === "function" ? status(payload) : status };
  };
  return { calls, post };
}

describe("runVoiceBackfill --dry-run", () => {
  it("reads the corpus and posts nothing", async () => {
    const { calls, post } = recordPost(201);

    const counts = await runVoiceBackfill({
      format: "markdown-dir",
      path: MD,
      voice: VOICE,
      channel: "linkedin",
      dryRun: true,
      post,
      now,
    });

    expect(calls).toEqual([]);
    expect(counts).toEqual({ read: 4, stored: 0, skipped: 1, rejected: 1 });
  });

  it("reports the jsonl counts it would act on", async () => {
    const { calls, post } = recordPost(201);

    const counts = await runVoiceBackfill({
      format: "jsonl",
      path: JSONL,
      voice: VOICE,
      dryRun: true,
      post,
      now,
    });

    expect(calls).toEqual([]);
    expect(counts).toEqual({ read: 3, stored: 0, skipped: 0, rejected: 8 });
  });
});

describe("runVoiceBackfill markdown-dir", () => {
  it("posts one payload per readable file, in the endpoint's own field names", async () => {
    const { calls, post } = recordPost(201);

    const counts = await runVoiceBackfill({
      format: "markdown-dir",
      path: MD,
      voice: VOICE,
      channel: "email-professional",
      post,
      now,
    });

    expect(counts).toEqual({ read: 4, stored: 4, skipped: 1, rejected: 1 });
    expect(calls).toEqual([
      {
        voice: VOICE,
        channel: "email-professional",
        text: "The slug is the provenance when the site URL has not been built yet.",
        source: "published",
        outcome: "published",
        source_ref: "voice/slug-instead-of-url",
        context: null,
        ts: "2026-01-02T09:00:00.000Z",
      },
      {
        voice: VOICE,
        channel: "email-professional",
        text: "No date in the frontmatter, so the reader falls back to the caller's clock.",
        source: "published",
        outcome: "published",
        source_ref: "https://whtnxt.com/undated",
        context: null,
        ts: NOW,
      },
      {
        voice: VOICE,
        channel: "email-professional",
        text: "A note exported without any frontmatter at all. The whole file is the text.",
        source: "published",
        outcome: "published",
        source_ref: null,
        context: null,
        ts: NOW,
      },
      {
        voice: VOICE,
        channel: "email-professional",
        text: "Most automation fails for one reason: nobody wrote down what \"done\" means.\nPlain words, one idea, no hashtags.",
        source: "published",
        outcome: "published",
        source_ref: "https://whtnxt.com/one-job",
        context: null,
        ts: "2026-01-01T09:00:00.000Z",
      },
    ]);
  });

  it("counts a dedup(200) as skipped and a rejection(400/503) as rejected", async () => {
    const { post } = recordPost((payload) =>
      payload.source_ref === "voice/slug-instead-of-url" ? 200 : payload.source_ref === null ? 400 : 201,
    );

    const counts = await runVoiceBackfill({
      format: "markdown-dir",
      path: MD,
      voice: VOICE,
      channel: "linkedin",
      post,
      now,
    });

    expect(counts).toEqual({ read: 4, stored: 2, skipped: 2, rejected: 2 });
  });

  it("requires --channel, because a directory of files cannot name its own channel", async () => {
    const { calls, post } = recordPost(201);

    await expect(
      runVoiceBackfill({ format: "markdown-dir", path: MD, voice: VOICE, post, now }),
    ).rejects.toThrow(/--channel/);
    expect(calls).toEqual([]);
  });
});

describe("runVoiceBackfill jsonl", () => {
  it("carries the imported email's source, outcome and subject-line context to the endpoint", async () => {
    const { calls, post } = recordPost(201);

    await runVoiceBackfill({ format: "jsonl", path: JSONL, voice: VOICE, post, now });

    expect(calls[1]).toEqual({
      voice: VOICE,
      channel: "email-professional",
      text: "Can you approve the two drafts by Friday? The client call is Monday.",
      source: "import",
      outcome: "approved",
      source_ref: "nocodb:4f2a",
      context: "Subject: Two drafts, Friday",
      ts: "2026-01-09T14:30:00.000Z",
    });
  });

  it("sends the lines in file order and one at a time", async () => {
    const order: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;

    await runVoiceBackfill({
      format: "jsonl",
      path: JSONL,
      voice: VOICE,
      post: async (payload) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        order.push(payload.channel);
        await Promise.resolve();
        inFlight -= 1;
        return { status: 201 };
      },
      now,
    });

    expect(order).toEqual(["linkedin", "email-professional", "linkedin"]);
    expect(maxInFlight).toBe(1);
  });
});

describe("backfill output", () => {
  it("is the four counts and nothing else", () => {
    expect(JSON.parse(formatVoiceBackfillCounts({ read: 12, stored: 9, skipped: 2, rejected: 1 }))).toEqual({
      read: 12,
      stored: 9,
      skipped: 2,
      rejected: 1,
    });
  });
});

describe("runVoiceBackfill on a path that is not there", () => {
  it("fails loudly instead of reporting an empty corpus", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nlm-voice-missing-"));
    rmSync(dir, { recursive: true, force: true });
    const { post } = recordPost(201);

    await expect(
      runVoiceBackfill({ format: "jsonl", path: join(dir, "nope.jsonl"), voice: VOICE, post, now }),
    ).rejects.toThrow();
  });

  it("fails loudly on an unknown format", async () => {
    const { post } = recordPost(201);
    await expect(
      runVoiceBackfill({ format: "csv", path: MD, voice: VOICE, channel: "linkedin", post, now }),
    ).rejects.toThrow(/csv/);
  });
});
