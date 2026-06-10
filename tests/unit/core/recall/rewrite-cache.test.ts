import { describe, expect, it } from "vitest";
import { RewriteCache } from "../../../../src/core/recall/rewrite-cache.js";

const sample = (kw: string, sem: string) => ({ keywordQuery: kw, semanticQuery: sem });

describe("RewriteCache", () => {
  it("returns null on a miss", () => {
    const c = new RewriteCache();
    expect(c.get("nope")).toBeNull();
  });

  it("returns the cached entry on a hit within TTL", () => {
    const c = new RewriteCache();
    c.set("query", sample("kw", "sem"));
    expect(c.get("query")).toEqual(sample("kw", "sem"));
  });

  it("normalizes case + whitespace on key", () => {
    const c = new RewriteCache();
    c.set("Pgvector  THING", sample("pgvector", "pgvector"));
    expect(c.get("pgvector thing")).toEqual(sample("pgvector", "pgvector"));
  });

  it("expires entries after TTL", () => {
    const c = new RewriteCache({ ttlMs: 1000 });
    const now = 1_000_000;
    c.set("q", sample("k", "s"), now);
    expect(c.get("q", now + 999)).not.toBeNull();
    expect(c.get("q", now + 1001)).toBeNull();
  });

  it("evicts the oldest entry when capacity is reached", () => {
    const c = new RewriteCache({ maxEntries: 2 });
    c.set("a", sample("a", "a"));
    c.set("b", sample("b", "b"));
    c.set("c", sample("c", "c")); // evicts a
    expect(c.get("a")).toBeNull();
    expect(c.get("b")).not.toBeNull();
    expect(c.get("c")).not.toBeNull();
  });

  it("LRU-touches on read so recently-read entries survive eviction", () => {
    const c = new RewriteCache({ maxEntries: 2 });
    c.set("a", sample("a", "a"));
    c.set("b", sample("b", "b"));
    expect(c.get("a")).not.toBeNull(); // a is now most-recent
    c.set("c", sample("c", "c"));     // evicts b, not a
    expect(c.get("a")).not.toBeNull();
    expect(c.get("b")).toBeNull();
    expect(c.get("c")).not.toBeNull();
  });
});
