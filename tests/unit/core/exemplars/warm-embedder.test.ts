/**
 * Unit tests for warm-on-start: the code embedder is warmed once when
 * NLM_CODE_EXEMPLARS_ENABLED=1 and left cold when the flag is off. A failing
 * embed must never throw out of warmCodeEmbedder (best-effort).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { warmCodeEmbedder } from "../../../../src/core/exemplars/warm-embedder.js";
import type { CodeEmbedder, EmbedCodeResult } from "../../../../src/ports/code-embedder.js";

class CountingEmbedder implements CodeEmbedder {
  calls: Array<{ text: string; role: string }> = [];
  shouldThrow = false;
  async embed(text: string, role: "query" | "document"): Promise<EmbedCodeResult> {
    this.calls.push({ text, role });
    if (this.shouldThrow) throw new Error("cold model");
    return { vector: new Float32Array(768), dim: 768 };
  }
}

describe("warmCodeEmbedder", () => {
  const prev = process.env["NLM_CODE_EXEMPLARS_ENABLED"];
  afterEach(() => {
    if (prev === undefined) delete process.env["NLM_CODE_EXEMPLARS_ENABLED"];
    else process.env["NLM_CODE_EXEMPLARS_ENABLED"] = prev;
  });

  it("invokes the embedder once when the flag is on", async () => {
    process.env["NLM_CODE_EXEMPLARS_ENABLED"] = "1";
    const embedder = new CountingEmbedder();
    warmCodeEmbedder(embedder);
    await new Promise((r) => setTimeout(r, 0));
    expect(embedder.calls.length).toBe(1);
  });

  it("skips the embedder when the flag is off", async () => {
    delete process.env["NLM_CODE_EXEMPLARS_ENABLED"];
    const embedder = new CountingEmbedder();
    warmCodeEmbedder(embedder);
    await new Promise((r) => setTimeout(r, 0));
    expect(embedder.calls.length).toBe(0);
  });

  it("never throws when the warm embed fails", async () => {
    process.env["NLM_CODE_EXEMPLARS_ENABLED"] = "1";
    const embedder = new CountingEmbedder();
    embedder.shouldThrow = true;
    expect(() => warmCodeEmbedder(embedder)).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(embedder.calls.length).toBe(1);
  });
});
