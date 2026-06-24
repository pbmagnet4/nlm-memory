// tests/unit/core/workstream/resolve.test.ts
import { describe, expect, it } from "vitest";
import { resolveWorkstreamId } from "../../../../src/core/workstream/resolve.js";
import { makeWorkstreamId, normalizeLabel } from "../../../../src/core/workstream/model.js";

const node = (id: string, mergedInto: string | null) => [id, { id, mergedInto }] as const;

describe("resolveWorkstreamId", () => {
  it("returns the id unchanged when it is the live survivor", () => {
    const map = new Map([node("ws_a", null)]);
    expect(resolveWorkstreamId("ws_a", map)).toBe("ws_a");
  });

  it("walks a merge chain to the live survivor", () => {
    const map = new Map([node("ws_a", "ws_b"), node("ws_b", "ws_c"), node("ws_c", null)]);
    expect(resolveWorkstreamId("ws_a", map)).toBe("ws_c");
  });

  it("returns the id unchanged when not present in the map (fail-open)", () => {
    expect(resolveWorkstreamId("ws_missing", new Map())).toBe("ws_missing");
  });

  it("does not loop forever on a cycle", () => {
    const map = new Map([node("ws_a", "ws_b"), node("ws_b", "ws_a")]);
    const out = resolveWorkstreamId("ws_a", map);
    expect(["ws_a", "ws_b"]).toContain(out);
  });
});

describe("model helpers", () => {
  it("makeWorkstreamId is prefixed and unique", () => {
    const a = makeWorkstreamId(), b = makeWorkstreamId();
    expect(a.startsWith("ws_")).toBe(true);
    expect(a).not.toBe(b);
  });

  it("normalizeLabel lowercases and collapses whitespace", () => {
    expect(normalizeLabel("  NLM   Memory ")).toBe("nlm memory");
  });
});
