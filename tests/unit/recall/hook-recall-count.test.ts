import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { countRecentInjections } from "../../../src/core/recall/hook-recall-log.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const nowTs = (agoDays: number) => new Date(Date.now() - agoDays * DAY_MS).toISOString();

function line(ts: string, wouldInject: string[] | undefined): string {
  return JSON.stringify({
    ts,
    conversationId: "c",
    promptPreview: "p",
    ...(wouldInject ? { wouldInject } : {}),
  });
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "nlm-count-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("countRecentInjections", () => {
  it("counts ids inside the window and ignores everything else", () => {
    const p = join(tmp, "hook-log.jsonl");
    writeFileSync(
      p,
      [
        line(nowTs(1), ["a", "b"]),
        line(nowTs(2), ["a"]),
        line(nowTs(13), ["b", "b"]),
        line(nowTs(15), ["a", "a", "a"]), // outside the 14d window
        JSON.stringify({ ts: nowTs(1), kind: "stop" }), // no wouldInject
        "not json at all",
        line(nowTs(1), undefined), // recall fire, nothing injected
        "",
      ].join("\n"),
    );
    const counts = countRecentInjections(14, p);
    expect([...counts.entries()].sort()).toEqual([["a", 2], ["b", 3]]);
  });

  it("discards a partial first line when tail-capping", () => {
    const p = join(tmp, "hook-log.jsonl");
    const full = line(nowTs(1), ["a"]);
    // The cap lands mid-`full`; the reader must not corrupt-count it and must
    // still read the following complete line.
    writeFileSync(p, `${full}\n${line(nowTs(1), ["b"])}\n`);
    const counts = countRecentInjections(14, p, full.length + 5);
    expect(counts.get("b")).toBe(1);
    expect(counts.has("a")).toBe(false);
  });

  it("fail-open: missing file yields an empty map", () => {
    expect(countRecentInjections(14, join(tmp, "nope.jsonl")).size).toBe(0);
  });
});
