import { describe, expect, it, vi } from "vitest";
import type { ClassifyResult, ExtractedFact, LLMClient } from "../../../src/ports/llm-client.js";
import { classifyAdaptive, classifyLarge, SINGLE_PASS_CHAR_BUDGET } from "../../../src/core/classifier/hierarchical-classify.js";

function res(p: Partial<ClassifyResult>): ClassifyResult {
  return { label: "", summary: "", entities: [], decisions: [], open: [], confidence: 1, facts: [], ...p };
}
// A fake classifier that returns a scripted result per call, in order.
function scripted(results: ClassifyResult[]): LLMClient {
  let i = 0;
  return {
    classify: vi.fn(async () => results[i++ % results.length]!),
    embed: async () => { throw new Error("not used"); },
    rewriteForRecall: async () => { throw new Error("not used"); },
  } as unknown as LLMClient;
}

const f = (subject: string): ExtractedFact => ({ subject, predicate: "uses", value: "x", kind: "attribute" });

describe("classifyLarge", () => {
  it("unions and case-insensitively dedupes entities/decisions/open across chunks", async () => {
    const clf = scripted([
      res({ label: "A", summary: "sa", entities: ["DuckDB", "Hono"], decisions: ["use wal"], open: ["q1"], confidence: 0.9 }),
      res({ label: "B", summary: "sb", entities: ["duckdb", "Vite"], decisions: ["use wal"], open: ["q2"], confidence: 0.8 }),
    ]);
    const big = "x".repeat(60_000); // 60K chars → exactly 2 chunks at 40K/1K (step=39K)
    const out = await classifyLarge(big, clf);
    expect(out.entities.map((e) => e.toLowerCase()).sort()).toEqual(["duckdb", "hono", "vite"]);
    expect(out.decisions).toEqual(["use wal"]); // deduped
    expect([...out.open].sort()).toEqual(["q1", "q2"]);
    expect(out.confidence).toBe(0.8); // min
    expect(out.label).toBe("A"); // first non-empty
  });

  it("concatenates facts from all chunks (dedupe deferred to ingest supersedence)", async () => {
    const clf = scripted([res({ facts: [f("a")] }), res({ facts: [f("b")] })]);
    const out = await classifyLarge("y".repeat(60_000), clf);
    expect(out.facts).toHaveLength(2);
  });

  it("skips a chunk that fails and merges the survivors", async () => {
    // 2 chunks at 40K/1K from a 60K body. First classify throws, second succeeds.
    let call = 0;
    const clf = {
      classify: vi.fn(async () => {
        call++;
        if (call === 1) throw new Error("ollama returned non-JSON content");
        return { label: "B", summary: "sb", entities: ["Hono"], decisions: ["d2"], open: [], confidence: 0.8, facts: [] };
      }),
      embed: async () => { throw new Error("nope"); },
      rewriteForRecall: async () => { throw new Error("nope"); },
    } as unknown as LLMClient;
    const out = await classifyLarge("x".repeat(60_000), clf);
    expect((clf.classify as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
    expect(out.entities).toEqual(["Hono"]);    // only the surviving chunk's content
    expect(out.decisions).toEqual(["d2"]);
    expect(out.label).toBe("B");
  });

  it("throws when every chunk fails", async () => {
    const clf = {
      classify: vi.fn(async () => { throw new Error("ollama returned non-JSON content"); }),
      embed: async () => { throw new Error("nope"); },
      rewriteForRecall: async () => { throw new Error("nope"); },
    } as unknown as LLMClient;
    await expect(classifyLarge("y".repeat(60_000), clf)).rejects.toThrow(/all \d+ chunks failed classification/);
  });
});

describe("classifyAdaptive", () => {
  it("single-passes a short body (one classify call, no chunking)", async () => {
    const clf = scripted([res({ label: "short", entities: ["a"] })]);
    await classifyAdaptive("short body", clf);
    expect(clf.classify).toHaveBeenCalledTimes(1);
  });

  it("routes an oversized body through classifyLarge (multiple calls)", async () => {
    const clf = scripted([res({ entities: ["a"] }), res({ entities: ["b"] })]);
    await classifyAdaptive("z".repeat(SINGLE_PASS_CHAR_BUDGET + 50_000), clf);
    expect((clf.classify as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1);
  });
});
