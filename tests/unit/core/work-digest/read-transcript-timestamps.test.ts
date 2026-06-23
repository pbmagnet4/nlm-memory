import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readTranscriptTimestamps } from "../../../../src/core/work-digest/read-transcript-timestamps.js";

describe("readTranscriptTimestamps", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "nlm-ttx-")); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  const from = Date.parse("2026-06-23T00:00:00.000Z");
  const to = Date.parse("2026-06-24T00:00:00.000Z");

  it("returns sorted in-window timestamps and skips out-of-window + garbage", () => {
    const p = join(tmp, "t.jsonl");
    writeFileSync(p, [
      JSON.stringify({ timestamp: "2026-06-23T10:00:00.000Z" }),
      JSON.stringify({ timestamp: "2026-06-22T10:00:00.000Z" }), // before window
      "not json",                                                  // garbage
      JSON.stringify({ nope: true }),                              // no timestamp
      JSON.stringify({ timestamp: "2026-06-23T08:00:00.000Z" }),
    ].join("\n"));
    expect(readTranscriptTimestamps(p, from, to)).toEqual([
      Date.parse("2026-06-23T08:00:00.000Z"),
      Date.parse("2026-06-23T10:00:00.000Z"),
    ]);
  });

  it("returns [] for a missing file", () => {
    expect(readTranscriptTimestamps(join(tmp, "missing.jsonl"), from, to)).toEqual([]);
  });
});
