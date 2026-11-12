import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { countRecentInjectionPrompts, readTailText } from "../../../src/core/recall/hook-recall-log.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const nowTs = (agoDays: number) => new Date(Date.now() - agoDays * DAY_MS).toISOString();

function line(ts: string, wouldInject: string[] | undefined, preview = "prompt one"): string {
  return JSON.stringify({
    ts,
    conversationId: "c",
    promptPreview: preview,
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

describe("countRecentInjectionPrompts", () => {
  it("counts DISTINCT prompts inside the window and ignores everything else", () => {
    const p = join(tmp, "hook-log.jsonl");
    writeFileSync(
      p,
      [
        line(nowTs(1), ["a", "b"]),
        line(nowTs(2), ["a"]), // same preview as above — one prompt, two fires
        line(nowTs(13), ["b", "b"], "prompt two"), // second distinct prompt for b
        line(nowTs(15), ["a", "a", "a"], "prompt three"), // outside the 14d window
        JSON.stringify({ ts: nowTs(1), kind: "stop" }), // no wouldInject
        "not json at all",
        line(nowTs(1), undefined), // recall fire, nothing injected
        "",
      ].join("\n"),
    );
    const counts = countRecentInjectionPrompts(14, p);
    expect([...counts.entries()].sort()).toEqual([["a", 1], ["b", 2]]);
  });

  it("collapses fires without a promptPreview into spread 1", () => {
    const p = join(tmp, "hook-log.jsonl");
    writeFileSync(
      p,
      [
        JSON.stringify({ ts: nowTs(1), conversationId: "c", wouldInject: ["a"] }),
        JSON.stringify({ ts: nowTs(2), conversationId: "d", wouldInject: ["a"] }),
      ].join("\n"),
    );
    expect(countRecentInjectionPrompts(14, p).get("a")).toBe(1);
  });

  it("discards a partial first line when tail-capping", () => {
    const p = join(tmp, "hook-log.jsonl");
    const full = line(nowTs(1), ["a"]);
    // The cap lands mid-`full`; the reader must not corrupt-count it and must
    // still read the following complete line.
    writeFileSync(p, `${full}\n${line(nowTs(1), ["b"], "prompt two")}\n`);
    const counts = countRecentInjectionPrompts(14, p, full.length + 5);
    expect(counts.get("b")).toBe(1);
    expect(counts.has("a")).toBe(false);
  });

  it("fail-open: missing file yields an empty map", () => {
    expect(countRecentInjectionPrompts(14, join(tmp, "nope.jsonl")).size).toBe(0);
  });
});

describe("readTailText — the shared tail seek", () => {
  it("returns a file that fits the cap whole", () => {
    const p = join(tmp, "hook-log.jsonl");
    writeFileSync(p, `${line(nowTs(1), ["a"])}\n${line(nowTs(1), ["b"])}\n`);
    expect(readTailText(p, 1024 * 1024).trim().split("\n")).toHaveLength(2);
  });

  it("returns nothing rather than a half record when the cap holds no whole line", () => {
    const p = join(tmp, "hook-log.jsonl");
    writeFileSync(p, `${line(nowTs(1), ["a"])}\n`);
    expect(readTailText(p, 8)).toBe("");
  });

  it("returns nothing for a missing or unreadable log", () => {
    expect(readTailText(join(tmp, "nope.jsonl"), 1024)).toBe("");
  });
});
