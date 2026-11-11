import { describe, expect, it } from "vitest";
import { CodeEmbedderBox, EmbedderBox } from "../../../src/llm/embedder-box.js";

describe("EmbedderBox", () => {
  it("delegates embed to the current inner client and uses a swapped one on the next call", async () => {
    const seen: string[] = [];
    const client = (tag: string) => ({ embed: async (t: string) => { seen.push(`${tag}:${t}`); return { vector: new Float32Array([1]), model: tag }; } }) as never;
    const box = new EmbedderBox(client("a"));
    expect((await box.embed("x", "query")).model).toBe("a");
    box.swap(client("b"));
    expect((await box.embed("y", "document")).model).toBe("b");
    expect(seen).toEqual(["a:x", "b:y"]);
  });
});

describe("CodeEmbedderBox", () => {
  it("swaps the code embedder live", async () => {
    const client = (dim: number) => ({ embed: async () => ({ vector: new Float32Array(dim), dim }) });
    const box = new CodeEmbedderBox(client(2));
    expect((await box.embed("x", "query")).dim).toBe(2);
    box.swap(client(3));
    expect((await box.embed("x", "query")).dim).toBe(3);
  });
});
