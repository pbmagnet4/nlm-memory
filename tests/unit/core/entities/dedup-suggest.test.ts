import { describe, expect, it } from "vitest";
import { suggestMerges, type EntityInput } from "../../../../src/core/entities/dedup-suggest.js";

function entity(canonical: string, sessionCount: number, status = "candidate"): EntityInput {
  return { canonical, sessionCount, status };
}

describe("suggestMerges", () => {
  describe("empty input", () => {
    it("returns empty array for empty input", () => {
      expect(suggestMerges([])).toEqual([]);
    });

    it("returns empty array for a single entity", () => {
      expect(suggestMerges([entity("Foo", 3)])).toEqual([]);
    });
  });

  describe("retired excluded", () => {
    it("does not suggest retired entities as source or target", () => {
      const result = suggestMerges([
        entity("Foo", 10),
        entity("foo", 5, "retired"),
      ]);
      expect(result).toEqual([]);
    });

    it("excludes retired entities even when a live pair would otherwise match", () => {
      const result = suggestMerges([
        entity("nlm-ts", 5, "retired"),
        entity("nlm", 3),
      ]);
      expect(result).toEqual([]);
    });
  });

  describe("safe class -- case-fold and punctuation/whitespace-fold identical", () => {
    it("suggests safe merge for case difference only", () => {
      const result = suggestMerges([entity("Foo", 5), entity("foo", 3)]);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ source: "foo", target: "Foo", cls: "safe" });
    });

    it("suggests safe merge for hyphen vs no-separator", () => {
      const result = suggestMerges([entity("my-project", 4), entity("myproject", 7)]);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ source: "my-project", target: "myproject", cls: "safe" });
    });

    it("suggests safe merge for underscore vs dot vs space", () => {
      const result = suggestMerges([entity("my_project", 2), entity("my.project", 2)]);
      expect(result).toHaveLength(1);
      expect(result[0]!.cls).toBe("safe");
    });

    it("handles three-way safe group with one target and two sources", () => {
      const result = suggestMerges([
        entity("FOO", 10),
        entity("foo", 5),
        entity("Foo", 3),
      ]);
      const safe = result.filter((r) => r.cls === "safe");
      expect(safe).toHaveLength(2);
      expect(safe.every((r) => r.target === "FOO")).toBe(true);
    });
  });

  describe("target selection: higher sessionCount wins, tie breaks lexicographically", () => {
    it("target is the entity with more sessions", () => {
      const result = suggestMerges([entity("alpha", 1), entity("ALPHA", 10)]);
      expect(result[0]).toMatchObject({ target: "ALPHA", source: "alpha", cls: "safe" });
    });

    it("on session count tie, lexicographically smaller canonical is target", () => {
      const result = suggestMerges([entity("beta", 5), entity("BETA", 5)]);
      expect(result[0]).toMatchObject({ target: "BETA", source: "beta", cls: "safe" });
    });

    it("likely pair: higher count wins over lexicographic", () => {
      const result = suggestMerges([entity("widget", 1), entity("widgets", 9)]);
      expect(result[0]).toMatchObject({ target: "widgets", source: "widget", cls: "likely" });
    });

    it("likely pair tie: lexicographically smaller is target", () => {
      const result = suggestMerges([entity("widget", 5), entity("widgets", 5)]);
      expect(result[0]).toMatchObject({ target: "widget", source: "widgets", cls: "likely" });
    });
  });

  describe("likely class -- singular/plural", () => {
    it("suggests likely merge for singular/plural pair", () => {
      const result = suggestMerges([entity("widget", 3), entity("widgets", 2)]);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ cls: "likely" });
      const canonicals = [result[0]!.source, result[0]!.target];
      expect(canonicals).toContain("widget");
      expect(canonicals).toContain("widgets");
    });

    it("does not suggest likely for non-plural suffix difference (e.g. suffix not just -s)", () => {
      const result = suggestMerges([entity("widget", 3), entity("widgetss", 2)]);
      expect(result).toHaveLength(0);
    });

    it("plural/singular is symmetric -- b+s=a direction", () => {
      const result = suggestMerges([entity("entities", 5), entity("entity", 2)]);
      expect(result).toHaveLength(0);
    });
  });

  describe("likely class -- repo suffix pattern", () => {
    it("suggests likely merge for -ts suffix pair", () => {
      const result = suggestMerges([entity("nlm", 5), entity("nlm-ts", 3)]);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ cls: "likely" });
    });

    it("suggests likely merge for -js suffix pair", () => {
      const result = suggestMerges([entity("nlm-js", 3), entity("nlm", 7)]);
      expect(result[0]).toMatchObject({ target: "nlm", source: "nlm-js", cls: "likely" });
    });

    it("suggests likely merge for -py suffix pair", () => {
      const result = suggestMerges([entity("mylib-py", 2), entity("mylib", 4)]);
      expect(result[0]).toMatchObject({ target: "mylib", source: "mylib-py", cls: "likely" });
    });

    it("suggests likely merge for -rs suffix pair", () => {
      const result = suggestMerges([entity("core-rs", 1), entity("core", 6)]);
      expect(result[0]).toMatchObject({ cls: "likely" });
    });

    it("suggests likely merge for -go suffix pair", () => {
      const result = suggestMerges([entity("agent-go", 1), entity("agent", 3)]);
      expect(result[0]).toMatchObject({ cls: "likely" });
    });

    it("does not suggest for a suffix that is not in the allowed list", () => {
      const result = suggestMerges([entity("mylib-rb", 3), entity("mylib", 4)]);
      expect(result).toHaveLength(0);
    });

    it("does not match when neither side has a repo suffix", () => {
      const result = suggestMerges([entity("mylib", 3), entity("mylib2", 4)]);
      expect(result).toHaveLength(0);
    });
  });

  describe("group behavior -- no chaining", () => {
    it("safe group: all non-target members become sources into the single target", () => {
      const result = suggestMerges([
        entity("Alpha", 10),
        entity("alpha", 5),
        entity("ALPHA", 1),
      ]);
      const safe = result.filter((r) => r.cls === "safe");
      const targets = new Set(safe.map((r) => r.target));
      const sources = new Set(safe.map((r) => r.source));
      expect(targets.size).toBe(1);
      expect(sources.size).toBe(2);
      expect(sources.has([...targets][0]!)).toBe(false);
    });

    it("an entity consumed as a safe source does not appear in likely suggestions", () => {
      const result = suggestMerges([
        entity("widgets", 5),
        entity("Widgets", 3),
        entity("widget", 2),
      ]);
      const likelySources = result.filter((r) => r.cls === "likely").map((r) => r.source);
      expect(likelySources).not.toContain("Widgets");
    });
  });
});
