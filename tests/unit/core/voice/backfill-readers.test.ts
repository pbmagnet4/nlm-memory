/**
 * Backfill readers (T2438 piece C, design §C4): pure file readers, so the
 * whole markdown/jsonl surface is testable without a daemon or a store.
 *
 * The fixtures under tests/fixtures/voice/ are the contract: frontmatter
 * variants, an empty body, an unparseable file, and a jsonl corpus whose bad
 * lines each fail one way the importer can be pointed at.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readJsonl, readMarkdownDir } from "../../../../src/core/voice/backfill-readers.js";

const FIXTURES = resolve("tests/fixtures/voice");
const NOW = "2026-11-23T12:00:00.000Z";
const now = () => NOW;

describe("readMarkdownDir", () => {
  const result = readMarkdownDir(join(FIXTURES, "md"), { channel: "linkedin", now });

  it("reads every *.md below the path, in path order, and nothing else", () => {
    expect(result.records.map((r) => r.text)).toEqual([
      "The slug is the provenance when the site URL has not been built yet.",
      "No date in the frontmatter, so the reader falls back to the caller's clock.",
      "A note exported without any frontmatter at all. The whole file is the text.",
      "Most automation fails for one reason: nobody wrote down what \"done\" means.\nPlain words, one idea, no hashtags.",
    ]);
  });

  it("takes the channel from the caller and the provenance from url, slug or published_at", () => {
    expect(result.records.map((r) => [r.channel, r.sourceRef, r.ts])).toEqual([
      ["linkedin", "voice/slug-instead-of-url", "2026-01-02T09:00:00.000Z"],
      ["linkedin", "https://whtnxt.com/undated", NOW],
      ["linkedin", null, NOW],
      ["linkedin", "https://whtnxt.com/one-job", "2026-01-01T09:00:00.000Z"],
    ]);
  });

  it("counts an empty body as skipped and an unparseable file as rejected", () => {
    expect(result.skipped).toBe(1);
    expect(result.rejected).toBe(1);
  });

  it("lands every markdown row as published/published with no context", () => {
    for (const record of result.records) {
      expect([record.source, record.outcome, record.context]).toEqual(["published", "published", null]);
    }
  });

  it("rejects a line whose date is not a date", () => {
    const dir = mkdtempSync(join(tmpdir(), "nlm-voice-reader-"));
    try {
      writeFileSync(join(dir, "bad-date.md"), "---\nurl: https://whtnxt.com/x\ndate: the day before yesterday\n---\n\nBody.\n");
      expect(readMarkdownDir(dir, { channel: "linkedin", now })).toEqual({ records: [], skipped: 0, rejected: 1 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("readJsonl", () => {
  const result = readJsonl(join(FIXTURES, "posts.jsonl"), { now });

  it("reads one good record per parseable line and counts every bad one", () => {
    expect(result.records).toHaveLength(3);
    expect(result.skipped).toBe(0);
    expect(result.rejected).toBe(8);
  });

  it("defaults source, outcome, context and ref when the line carries none", () => {
    expect(result.records[0]).toEqual({
      channel: "linkedin",
      text: "Automation is a documentation problem, not a tooling problem.",
      sourceRef: "https://whtnxt.com/documentation-problem",
      source: "published",
      outcome: "published",
      context: null,
      ts: "2026-01-08T09:00:00.000Z",
    });
  });

  it("passes the imported-email triple through: source, outcome and the subject as context", () => {
    expect(result.records[1]).toEqual({
      channel: "email-professional",
      text: "Can you approve the two drafts by Friday? The client call is Monday.",
      sourceRef: "nocodb:4f2a",
      source: "import",
      outcome: "approved",
      context: "Subject: Two drafts, Friday",
      ts: "2026-01-09T14:30:00.000Z",
    });
  });

  it("falls back to the caller's clock and a null ref for a bare line", () => {
    expect(result.records[2]).toEqual({
      channel: "linkedin",
      text: "A second good line with no date or ref.",
      sourceRef: null,
      source: "published",
      outcome: "published",
      context: null,
      ts: NOW,
    });
  });

  it("accepts a rejected outcome so recall can build the avoid list, keeping the default source", () => {
    const dir = mkdtempSync(join(tmpdir(), "nlm-voice-reader-"));
    try {
      writeFileSync(join(dir, "avoid.jsonl"), '{"channel":"email","text":"Too salesy.","outcome":"rejected"}\n');
      expect(readJsonl(join(dir, "avoid.jsonl"), { now }).records[0]).toMatchObject({
        outcome: "rejected",
        source: "published",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a pending_review outcome, which backfill never produces", () => {
    const dir = mkdtempSync(join(tmpdir(), "nlm-voice-reader-"));
    try {
      writeFileSync(join(dir, "pending.jsonl"), '{"channel":"email","text":"Half-written.","outcome":"pending_review"}\n');
      expect(readJsonl(join(dir, "pending.jsonl"), { now })).toEqual({ records: [], skipped: 0, rejected: 1 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("both readers on an empty corpus", () => {
  const dir = mkdtempSync(join(tmpdir(), "nlm-voice-reader-empty-"));
  mkdirSync(join(dir, "md"), { recursive: true });

  it("returns zeros instead of throwing", () => {
    expect(readMarkdownDir(join(dir, "md"), { channel: "linkedin", now })).toEqual({ records: [], skipped: 0, rejected: 0 });
  });
});
