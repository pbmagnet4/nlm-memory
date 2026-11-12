/**
 * T1782 Part 2: the nightly Clef relevance judge.
 *
 * What is load-bearing here and therefore tested: the sampling rule (which hook
 * records are judgeable at all, the 24 h window, the capped even stride), the
 * call shape the eval measured (one call per prompt, `chunk` memories per call,
 * one score question per memory), the kept-share aggregation, the bounded store
 * reads, and the failure policy — one WARN, the previous sample left standing,
 * never a throw into the caller.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  aggregateRelevance,
  expandMemories,
  parseInjectionRecord,
  readTail,
  relevanceQuestionKey,
  relevanceQuestions,
  relevanceJudgeEnabled,
  relevanceSettings,
  relevanceStatePath,
  RELEVANCE_CHUNK_DEFAULT,
  RELEVANCE_THRESHOLD_DEFAULT,
  runRelevanceNightly,
  sampleRecords,
  type InjectionRecord,
  type RelevanceMemory,
} from "../../../../src/core/health/relevance-judge.js";
import type { ClefAnswer, ClefQuestion } from "../../../../src/llm/clef-client.js";
import type { SloRelevanceSample } from "../../../../src/core/health/slo-metrics.js";

const NOW = Date.UTC(2026, 1, 5, 12, 0, 0, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** A prompt-recall fire as the hook writes it (kind-less, recallOutcome ok). */
function recallLine(tsMs: number, ids: string[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ts: new Date(tsMs).toISOString(),
    conversationId: "conv-1",
    promptPreview: "what did we decide about the slo endpoint",
    hits: ids.map((id, i) => ({ id, score: 0.9 - i * 0.01 })),
    wouldInject: ids,
    estTokens: 120,
    recallOutcome: "ok",
    ...extra,
  });
}

const MEMO: RelevanceMemory = { id: "s1", label: "SLO endpoint design", summary: "Chose a gauge, not a counter." };

function sessionsWith(memos: readonly RelevanceMemory[], spy?: string[][]) {
  return {
    getByIds: async (_tenant: string, ids: readonly string[]) => {
      spy?.push([...ids]);
      return memos.filter((m) => ids.includes(m.id));
    },
  };
}

function score(v: number): ClefAnswer {
  return { type: "score", score: v, confidence: 0.8, probabilities: {}, legend: {} };
}

function answersFor(vs: number[]): Record<string, ClefAnswer> {
  return Object.fromEntries(vs.map((v, i) => [relevanceQuestionKey(i), score(v)]));
}

describe("relevanceJudgeEnabled / relevanceSettings", () => {
  it("is off unless the flag says on", () => {
    expect(relevanceJudgeEnabled({})).toBe(false);
    expect(relevanceJudgeEnabled({ NLM_RELEVANCE_JUDGE: "true" })).toBe(false);
    expect(relevanceJudgeEnabled({ NLM_RELEVANCE_JUDGE: " on " })).toBe(true);
  });

  it("defaults are the measured configuration", () => {
    expect(relevanceSettings({})).toEqual({
      sample: 60,
      threshold: RELEVANCE_THRESHOLD_DEFAULT,
      phrasing: "same",
      chunk: RELEVANCE_CHUNK_DEFAULT,
    });
    // The doc's tune-fit for `same` at 8 memories/call — the number is only
    // comparable night to night while these stay put.
    expect(RELEVANCE_THRESHOLD_DEFAULT).toBe(1.43);
    expect(RELEVANCE_CHUNK_DEFAULT).toBe(8);
  });

  it("honours overrides and falls back on anything invalid", () => {
    expect(relevanceSettings({
      NLM_RELEVANCE_SAMPLE: "20",
      NLM_RELEVANCE_THRESHOLD: "1.11",
      NLM_RELEVANCE_PHRASING: "dev",
      NLM_RELEVANCE_CHUNK: "1",
    })).toEqual({ sample: 20, threshold: 1.11, phrasing: "dev", chunk: 1 });
    for (const bad of ["", "abc", "0", "-3", "NaN"]) {
      expect(relevanceSettings({ NLM_RELEVANCE_SAMPLE: bad, NLM_RELEVANCE_THRESHOLD: bad, NLM_RELEVANCE_CHUNK: bad }).sample)
        .toBe(60);
      expect(relevanceSettings({ NLM_RELEVANCE_THRESHOLD: bad }).threshold).toBe(RELEVANCE_THRESHOLD_DEFAULT);
      expect(relevanceSettings({ NLM_RELEVANCE_CHUNK: bad }).chunk).toBe(RELEVANCE_CHUNK_DEFAULT);
    }
    // A score at or above the threshold keeps, so 0 would keep everything: that
    // is "off" wearing the metric's clothes, and as invalid as a typo. Above the
    // rubric's ceiling nothing would ever be kept.
    expect(relevanceSettings({ NLM_RELEVANCE_THRESHOLD: "4" }).threshold).toBe(RELEVANCE_THRESHOLD_DEFAULT);
    expect(relevanceSettings({ NLM_RELEVANCE_THRESHOLD: "1.4" }).threshold).toBe(1.4);
    expect(relevanceSettings({ NLM_RELEVANCE_PHRASING: "vibes" }).phrasing).toBe("same");
  });

  it("keeps its marker next to the other state files, under an override", () => {
    expect(relevanceStatePath({ NLM_RELEVANCE_STATE: "/tmp/x.json" })).toBe("/tmp/x.json");
    expect(relevanceStatePath({})).toMatch(/relevance-nightly\.json$/);
  });
});

describe("parseInjectionRecord", () => {
  it("takes a kind-less ok recall fire with a prompt and injections", () => {
    expect(parseInjectionRecord(recallLine(NOW, ["s1", "s2"]))).toEqual({
      ts: NOW,
      conversationId: "conv-1",
      promptPreview: "what did we decide about the slo endpoint",
      memoryIds: ["s1", "s2"],
    });
  });

  it("ignores everything the judge cannot score", () => {
    const cases: [string, string][] = [
      [recallLine(NOW, ["s1"], { kind: "stop" }), "kind-carrying fire"],
      [recallLine(NOW, ["s1"], { recallOutcome: "timeout" }), "recall did not return"],
      [recallLine(NOW, ["s1"], { recallOutcome: undefined }), "no outcome field at all"],
      [recallLine(NOW, []), "injected nothing"],
      [recallLine(NOW, ["s1"], { promptPreview: "" }), "no prompt to judge against"],
      [recallLine(NOW, ["s1"], { ts: "not-a-date" }), "unparseable ts"],
      ["{corrupt", "malformed line"],
      ["", "blank line"],
    ];
    for (const [line, why] of cases) expect(parseInjectionRecord(line), why).toBeNull();
  });
});

describe("sampleRecords", () => {
  function lines(n: number, tsStepMs = 60_000): string {
    return Array.from({ length: n }, (_, i) => recallLine(NOW - i * tsStepMs, [`s${i}`])).join("\n") + "\n";
  }

  it("keeps only the last 24h", () => {
    const text = recallLine(NOW - 23 * HOUR, ["a"]) + "\n" + recallLine(NOW - 25 * HOUR, ["b"]) + "\n";
    const picked = sampleRecords(text, { now: NOW, sample: 60 });
    expect(picked.map((r) => r.memoryIds[0])).toEqual(["a"]);
  });

  it("caps at n and spreads the sample over the window", () => {
    const picked = sampleRecords(lines(100), { now: NOW, sample: 10 });
    expect(picked).toHaveLength(10);
    const gaps = picked.slice(1).map((r, i) => picked[i]!.ts - r.ts);
    // Newest first in the file, so gaps are positive and roughly the same size:
    // a stride sample, not "the last ten minutes of traffic".
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThanOrEqual(60_000);
    expect(picked[0]!.ts).toBe(NOW);
  });

  it("is deterministic for the same file and returns all of it under the cap", () => {
    const text = lines(7);
    const a = sampleRecords(text, { now: NOW, sample: 60 });
    expect(a).toHaveLength(7);
    expect(sampleRecords(text, { now: NOW, sample: 3 }).map((r) => r.ts))
      .toEqual(sampleRecords(text, { now: NOW, sample: 3 }).map((r) => r.ts));
  });

  it("skips junk lines among the records", () => {
    const text = "nope\n" + recallLine(NOW, ["a"]) + "\n\n";
    expect(sampleRecords(text, { now: NOW, sample: 60 })).toHaveLength(1);
  });
});

describe("readTail", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-rel-tail-"));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("reads the end of the file and drops the partial first line", () => {
    const path = join(tmp, "hook-log.jsonl");
    const a = recallLine(NOW - HOUR, ["a"]);
    const b = recallLine(NOW, ["b"]);
    writeFileSync(path, `${"x".repeat(500)}\n${a}\n${b}\n`, "utf8");
    // Cap covers the last record plus the tail of the one before it: that
    // leading fragment is dropped whole rather than half-parsed.
    expect(readTail(path, b.length + 40)).toBe(b + "\n");
  });

  it("returns nothing when not even one record fits the cap", () => {
    const path = join(tmp, "tiny.jsonl");
    writeFileSync(path, recallLine(NOW, ["a"]) + "\n", "utf8");
    expect(readTail(path, 8)).toBe("");
  });

  it("returns a short file whole, and nothing for a missing one", () => {
    const path = join(tmp, "small.jsonl");
    writeFileSync(path, full2(), "utf8");
    expect(readTail(path).trim().split("\n")).toHaveLength(2);
    expect(readTail(join(tmp, "nope.jsonl"))).toBe("");
  });

  function full2(): string {
    return recallLine(NOW, ["a"]) + "\n" + recallLine(NOW, ["b"]) + "\n";
  }
});

describe("relevanceQuestions", () => {
  it("asks one score question per memory, keyed positionally", () => {
    const q = relevanceQuestions([MEMO, { ...MEMO, id: "s2" }], "same");
    expect(Object.keys(q)).toEqual(["m0", "m1"]);
    const m0 = q["m0"]!;
    expect(m0.type).toBe("score");
    if (m0.type !== "score") return;
    expect(m0.instructions).toContain("same task or the same system");
    expect(m0.instructions).toContain(MEMO.label);
    expect(m0.instructions).toContain(MEMO.summary);
    expect(m0.criteria).toHaveLength(4);
    expect(m0.criteria[3]).toContain("Same task");
  });

  it("swaps only the wording between phrasings, and caps a long summary", () => {
    const long = { id: "s", label: "L", summary: "y".repeat(3000) };
    const direct = relevanceQuestions([long], "direct")["m0"]!;
    expect(direct.type === "score" && direct.instructions).toContain("How relevant is this memory");
    expect(direct.type === "score" && direct.instructions.length).toBeLessThan(1600);
  });
});

describe("aggregateRelevance", () => {
  const pair = (score: number) => ({
    ts: NOW,
    conversationId: "c",
    promptPreview: "p",
    memory: MEMO,
    score,
    kept: score >= RELEVANCE_THRESHOLD_DEFAULT,
  });

  it("is the kept share, with the threshold inclusive", () => {
    const agg = aggregateRelevance([pair(2), pair(0.5), pair(RELEVANCE_THRESHOLD_DEFAULT), pair(1.42)]);
    expect(agg).toEqual({ value: 0.5, pairs: 4, kept: 2 });
  });

  it("rounds to 4 dp and says nothing when nothing was scored", () => {
    expect(aggregateRelevance(Array.from({ length: 3 }, () => pair(3)))!.value).toBe(1);
    expect(aggregateRelevance(Array.from({ length: 3 }, () => pair(0)))!.value).toBe(0);
    // 1 of 7 = 0.142857.. -> the same rounding the timeout rate uses.
    expect(aggregateRelevance([pair(3), ...Array.from({ length: 6 }, () => pair(0))])!.value).toBe(0.1429);
    expect(aggregateRelevance([])).toBeNull();
  });
});

describe("expandMemories", () => {
  const rec = (ids: string[]): InjectionRecord => ({ ts: NOW, conversationId: "c", promptPreview: "p", memoryIds: ids });

  it("dedupes ids and reads the store in bounded batches", async () => {
    const batches: string[][] = [];
    const memos = Array.from({ length: 120 }, (_, i) => ({ id: `s${i}`, label: `L${i}`, summary: "s" }));
    const map = await expandMemories(sessionsWith(memos, batches), [rec(["s0", "s1", "s0"]), rec(memos.map((m) => m.id))], "t1");
    expect(map.size).toBe(120);
    expect(batches.map((b) => b.length)).toEqual([50, 50, 20]);
    expect(batches.every((b) => b.length <= 50)).toBe(true);
  });

  it("drops ids the store does not have instead of judging an empty memory", async () => {
    const map = await expandMemories(sessionsWith([MEMO]), [rec(["s1", "gone"])], "t1");
    expect([...map.keys()]).toEqual(["s1"]);
  });

  it("tolerates a null label or summary from the row", async () => {
    const reader = { getByIds: async () => [{ id: "s1", label: null, summary: null }] };
    expect((await expandMemories(reader, [rec(["s1"])], "t1")).get("s1")).toEqual({ id: "s1", label: "", summary: "" });
  });
});

describe("runRelevanceNightly", () => {
  let tmp: string;
  let log: string;
  let warns: string[];
  let recorded: SloRelevanceSample[];

  const ENV = {
    NLM_RELEVANCE_JUDGE: "on",
    NLM_CLEF_BASE_URL: "http://127.0.0.1:8080",
    NLM_CLEF_PATH: "/v1/systemone",
    NLM_CLEF_MODEL: "clef-flash-oQ8e",
  };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-rel-nightly-"));
    log = join(tmp, "hook-log.jsonl");
    warns = [];
    recorded = [];
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  function run(
    env: Record<string, string> = ENV,
    ask: (state: unknown, questions: Record<string, ClefQuestion>, opts: unknown) => Promise<{ answers: Record<string, ClefAnswer> }> = async () => ({ answers: answersFor([2]) }),
    memos: readonly RelevanceMemory[] = [MEMO],
  ) {
    return runRelevanceNightly({
      env,
      now: () => NOW,
      hookLog: log,
      sessions: sessionsWith(memos),
      ask: ask as never,
      logger: (m) => warns.push(m),
      record: (s) => recorded.push(s),
    });
  }

  it("does not exist when the flag is off: no read, no call, no log line", async () => {
    const res = await run({});
    expect(res).toEqual({ ran: false, reason: "off" });
    expect(warns).toEqual([]);
    expect(recorded).toEqual([]);
  });

  it("scores the sample and records the kept share with its provenance", async () => {
    writeFileSync(log, [recallLine(NOW - HOUR, ["s1"]), recallLine(NOW - 2 * HOUR, ["s1"])].join("\n") + "\n", "utf8");
    const seen: { state: unknown; keys: string[]; opts: { baseUrl: string; path: string; model: string } }[] = [];
    const res = await run(ENV, async (state, questions, opts) => {
      seen.push({ state, keys: Object.keys(questions), opts: opts as never });
      // First prompt relevant, second not.
      return { answers: answersFor(seen.length === 1 ? [RELEVANCE_THRESHOLD_DEFAULT] : [0.4]) };
    });
    expect(res).toEqual({ ran: true, value: 0.5, pairs: 2, model: "clef-flash-oQ8e" });
    // One call per prompt, the prompt alone in state, the direct oMLX endpoint.
    expect(seen).toHaveLength(2);
    expect(seen[0]!.state).toEqual({ prompt: "what did we decide about the slo endpoint" });
    expect(seen[0]!.keys).toEqual(["m0"]);
    expect(seen[0]!.opts).toMatchObject({
      baseUrl: "http://127.0.0.1:8080",
      path: "/v1/systemone",
      model: "clef-flash-oQ8e",
    });
    expect(recorded).toEqual([{
      at: NOW,
      value: 0.5,
      pairs: 2,
      threshold: RELEVANCE_THRESHOLD_DEFAULT,
      model: "clef-flash-oQ8e",
      phrasing: "same",
    }]);
    expect(warns).toEqual([]);
  });

  it("chunks memories into one call per chunk, in order", async () => {
    const memos = Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, label: `L${i}`, summary: "x" }));
    writeFileSync(log, recallLine(NOW - HOUR, memos.map((m) => m.id)) + "\n", "utf8");
    const keySets: string[][] = [];
    const res = await run(
      ENV,
      async (_s, questions) => {
        const keys = Object.keys(questions);
        keySets.push(keys);
        return { answers: answersFor(keys.map(() => 3)) };
      },
      memos,
    );
    expect(keySets).toEqual([["m0", "m1", "m2", "m3", "m4", "m5", "m6", "m7"], ["m0", "m1"]]);
    expect(res).toEqual({ ran: true, value: 1, pairs: 10, model: "clef-flash-oQ8e" });
  });

  it("a Clef error is one WARN and no sample: the previous night stands", async () => {
    writeFileSync(log, [recallLine(NOW - HOUR, ["s1"]), recallLine(NOW - 2 * HOUR, ["s1"])].join("\n") + "\n", "utf8");
    const res = await run(ENV, async () => {
      throw new Error("clef HTTP 413");
    });
    expect(res.ran).toBe(false);
    expect(res.ran === false && res.reason).toBe("clef-error");
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("clef HTTP 413");
    expect(warns[0]).toContain("skipping the night");
    expect(recorded).toEqual([]);
  });

  it("a reply missing a score is the same failure, not a dropped pair", async () => {
    writeFileSync(log, recallLine(NOW - HOUR, ["s1"]) + "\n", "utf8");
    const res = await run(ENV, async () => ({ answers: { other: score(2) } }));
    expect(res.ran === false && res.reason).toBe("clef-error");
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("no score for m0");
    expect(recorded).toEqual([]);
  });

  it("warns and skips when the judge was turned on with no endpoint", async () => {
    writeFileSync(log, recallLine(NOW - HOUR, ["s1"]) + "\n", "utf8");
    const res = await run({ NLM_RELEVANCE_JUDGE: "on" });
    expect(res).toEqual({ ran: false, reason: "no-clef", detail: undefined });
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("NLM_CLEF_BASE_URL");
    expect(recorded).toEqual([]);
  });

  it("says no-records when the window holds nothing judgeable", async () => {
    writeFileSync(log, recallLine(NOW - 3 * DAY, ["s1"]) + "\n", "utf8");
    expect(await run()).toEqual({ ran: false, reason: "no-records" });
    expect(warns).toEqual([]);
  });

  it("says no-pairs when every injected id is gone from the store", async () => {
    writeFileSync(log, recallLine(NOW - HOUR, ["deleted-1"]) + "\n", "utf8");
    expect(await run()).toEqual({ ran: false, reason: "no-pairs" });
    expect(recorded).toEqual([]);
  });
});
