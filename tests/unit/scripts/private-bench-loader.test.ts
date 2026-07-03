import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadLockedQueries,
  PrivateBenchRefusalError,
} from "../../../scripts/private-bench/locked-queries.js";

/** Write a JSON file in the temp dir and return its path. */
function writeFixture(dir: string, name: string, content: unknown): string {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(content), "utf8");
  return p;
}

/** Run loadLockedQueries with NLM_PRIVATE_BENCH_QUERIES set to a given path. */
function runWith(path: string | undefined): ReturnType<typeof loadLockedQueries> {
  const saved = process.env["NLM_PRIVATE_BENCH_QUERIES"];
  try {
    if (path === undefined) {
      delete process.env["NLM_PRIVATE_BENCH_QUERIES"];
    } else {
      process.env["NLM_PRIVATE_BENCH_QUERIES"] = path;
    }
    return loadLockedQueries();
  } finally {
    if (saved === undefined) {
      delete process.env["NLM_PRIVATE_BENCH_QUERIES"];
    } else {
      process.env["NLM_PRIVATE_BENCH_QUERIES"] = saved;
    }
  }
}

describe("loadLockedQueries", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nlm-private-bench-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses when NLM_PRIVATE_BENCH_QUERIES env var is unset", () => {
    expect(() => runWith(undefined)).toThrow(PrivateBenchRefusalError);
    expect(() => runWith(undefined)).toThrow(/NLM_PRIVATE_BENCH_QUERIES/);
  });

  it("refuses when the file does not exist", () => {
    const missing = join(dir, "does-not-exist.json");
    expect(() => runWith(missing)).toThrow(PrivateBenchRefusalError);
    expect(() => runWith(missing)).toThrow(/not found/i);
  });

  it("refuses when the file is not valid JSON", () => {
    const bad = join(dir, "malformed.json");
    writeFileSync(bad, "{ this is not json }", "utf8");
    expect(() => runWith(bad)).toThrow(PrivateBenchRefusalError);
    expect(() => runWith(bad)).toThrow(/not valid JSON/i);
  });

  it("refuses when locked is false", () => {
    const path = writeFixture(dir, "unlocked.json", {
      locked: false,
      lockedAt: "2026-07-01",
      queries: [{ id: "q1", category: "test", question: "what?", goldSessionIds: ["s1"] }],
    });
    expect(() => runWith(path)).toThrow(PrivateBenchRefusalError);
    expect(() => runWith(path)).toThrow(/locked/i);
  });

  it("refuses when locked is missing", () => {
    const path = writeFixture(dir, "no-locked.json", {
      lockedAt: "2026-07-01",
      queries: [{ id: "q1", category: "test", question: "what?", goldSessionIds: [] }],
    });
    expect(() => runWith(path)).toThrow(PrivateBenchRefusalError);
  });

  it("refuses when locked is a string 'true' rather than boolean true", () => {
    const path = writeFixture(dir, "string-true.json", {
      locked: "true",
      lockedAt: "2026-07-01",
      queries: [{ id: "q1", category: "test", question: "what?", goldSessionIds: [] }],
    });
    expect(() => runWith(path)).toThrow(PrivateBenchRefusalError);
  });

  it("refuses when queries array is empty", () => {
    const path = writeFixture(dir, "empty-queries.json", {
      locked: true,
      lockedAt: "2026-07-01",
      queries: [],
    });
    expect(() => runWith(path)).toThrow(PrivateBenchRefusalError);
    expect(() => runWith(path)).toThrow(/zero queries/i);
  });

  it("refuses when queries field is missing", () => {
    const path = writeFixture(dir, "no-queries.json", {
      locked: true,
      lockedAt: "2026-07-01",
    });
    expect(() => runWith(path)).toThrow(PrivateBenchRefusalError);
  });

  it("returns the query set when the file is well-formed and locked", () => {
    const path = writeFixture(dir, "valid.json", {
      locked: true,
      lockedAt: "2026-07-01",
      queries: [
        { id: "q1", category: "factual", question: "What color is the sky?", goldSessionIds: ["s1", "s2"] },
        { id: "q2", category: "temporal", question: "When was the last meeting?", goldSessionIds: ["s3"] },
      ],
    });
    const result = runWith(path);
    expect(result.lockedAt).toBe("2026-07-01");
    expect(result.queries).toHaveLength(2);
    expect(result.queries[0]?.id).toBe("q1");
    expect(result.queries[0]?.category).toBe("factual");
    expect(result.queries[0]?.goldSessionIds).toEqual(["s1", "s2"]);
    expect(result.queries[1]?.id).toBe("q2");
  });

  it("falls back to 'unknown' for lockedAt when the field is absent", () => {
    const path = writeFixture(dir, "no-locked-at.json", {
      locked: true,
      queries: [{ id: "q1", category: "test", question: "?", goldSessionIds: [] }],
    });
    const result = runWith(path);
    expect(result.lockedAt).toBe("unknown");
  });

  it("throws PrivateBenchRefusalError (not a generic Error) for every refusal", () => {
    // Ensure the error class hierarchy is correct so callers can catch narrowly.
    const path = writeFixture(dir, "zero.json", { locked: true, lockedAt: "x", queries: [] });
    let caught: unknown;
    try {
      runWith(path);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PrivateBenchRefusalError);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as PrivateBenchRefusalError).name).toBe("PrivateBenchRefusalError");
  });
});
