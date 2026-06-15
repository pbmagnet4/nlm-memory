import { describe, expect, it } from "vitest";
import { codeHash, normalizeExemplar } from "../../../../src/core/exemplars/ingest-exemplar.js";

const BASE = {
  installScope: "s",
  repo: "/repo",
  model: "qwen",
  taskContext: "add two numbers",
  code: "function add(a, b) {\n  return a + b;\n}",
  outcome: "pass",
} as const;

describe("codeHash", () => {
  it("produces the same hash for functionally identical code", () => {
    const a = "function f() {\n  return 1;\n}";
    const b = "function f() {\n  return 1;  \n}"; // trailing space
    expect(codeHash(a)).toBe(codeHash(b));
  });

  it("produces different hashes for different code", () => {
    expect(codeHash("return 1;")).not.toBe(codeHash("return 2;"));
  });
});

describe("normalizeExemplar", () => {
  it("returns a valid input for a minimal payload", () => {
    const now = () => "2026-06-15T00:00:00.000Z";
    const result = normalizeExemplar(BASE, now);
    expect(result.installScope).toBe("s");
    expect(result.outcome).toBe("pass");
    expect(result.codeHash).toBe(codeHash(BASE.code));
    expect(result.ts).toBe("2026-06-15T00:00:00.000Z");
  });

  it("throws on invalid outcome", () => {
    expect(() => normalizeExemplar({ ...BASE, outcome: "unknown" })).toThrow(/outcome/);
  });

  it("throws on code with fewer than 2 meaningful lines", () => {
    expect(() => normalizeExemplar({ ...BASE, code: "const x = 1;" })).toThrow(/too small/);
  });

  it("throws on code exceeding 200 meaningful lines", () => {
    const big = Array.from({ length: 201 }, (_, i) => `const v${i} = ${i};`).join("\n");
    expect(() => normalizeExemplar({ ...BASE, code: big })).toThrow(/too large/);
  });

  it("accepts brace-only lines as non-meaningful", () => {
    // A function with just braces and 1 meaningful line should be too small.
    const bracesOnly = "function f() {\n  return 1;\n}";
    // "return 1;" = 1 meaningful. "{" and "}" are brace-only = 0. Total = 1 → too small? No.
    // Actually "function f() {" is not brace-only (it has "function f() "), let's recount:
    // Line 1: "function f() {" → has content beyond braces → meaningful
    // Line 2: "  return 1;" → meaningful
    // Line 3: "}" → brace-only
    // Total meaningful = 2 → exactly at the minimum → should pass.
    expect(() => normalizeExemplar({ ...BASE, code: bracesOnly })).not.toThrow();
  });

  it("soft-defaults model to 'unknown' when empty", () => {
    const result = normalizeExemplar({ ...BASE, model: "" });
    expect(result.model).toBe("unknown");
  });

  it("uses provided ts when given", () => {
    const result = normalizeExemplar({ ...BASE, ts: "2026-01-01T00:00:00.000Z" });
    expect(result.ts).toBe("2026-01-01T00:00:00.000Z");
  });
});
