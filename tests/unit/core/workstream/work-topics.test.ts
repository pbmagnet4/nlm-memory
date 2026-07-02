// tests/unit/core/workstream/work-topics.test.ts
import { describe, expect, it } from "vitest";
import { parseWorkTopics, aliasToLabelMap, aliasesForLabel } from "../../../../src/core/workstream/work-topics.js";

describe("parseWorkTopics", () => {
  it("parses array shape", () => {
    const topics = parseWorkTopics([
      { label: "NLM", entities: ["NLM", "Daemon"] },
      { label: "Acme", entities: ["Acme", "acme corp"] },
    ]);
    expect(topics).toHaveLength(2);
    expect(topics[0]).toEqual({ label: "NLM", entities: ["NLM", "Daemon"] });
  });

  it("parses alias-map shape (string values)", () => {
    const topics = parseWorkTopics({ "nlm daemon": "NLM", "NLM": "NLM" });
    expect(topics).toHaveLength(1);
    expect(topics[0]!.label).toBe("NLM");
    expect(topics[0]!.entities).toContain("NLM");
    expect(topics[0]!.entities).toContain("nlm daemon");
  });

  it("parses label-to-entities map shape", () => {
    const topics = parseWorkTopics({ NLM: ["NLM", "Daemon"], Zephyr: ["Zephyr", "z proj"] });
    expect(topics).toHaveLength(2);
    expect(topics.find((t) => t.label === "Zephyr")?.entities).toContain("z proj");
  });

  it("throws on invalid input", () => {
    expect(() => parseWorkTopics("bad")).toThrow("work-topics:");
    expect(() => parseWorkTopics([{ label: 42, entities: [] }])).toThrow("work-topics:");
  });
});

describe("aliasToLabelMap", () => {
  it("maps normalized entities to canonical labels", () => {
    const topics = [
      { label: "NLM", entities: ["NLM", "Daemon", "nlm memory"] },
      { label: "Acme", entities: ["Acme", "acme corp"] },
    ];
    const map = aliasToLabelMap(topics);
    expect(map.get("nlm")).toBe("NLM");
    expect(map.get("daemon")).toBe("NLM");
    expect(map.get("nlm memory")).toBe("NLM");
    expect(map.get("acme")).toBe("Acme");
    expect(map.get("acme corp")).toBe("Acme");
  });

  it("returns empty map for empty topics", () => {
    expect(aliasToLabelMap([])).toEqual(new Map());
  });

  it("last write wins for duplicate normalized entities", () => {
    const topics = [
      { label: "A", entities: ["shared"] },
      { label: "B", entities: ["shared"] },
    ];
    const map = aliasToLabelMap(topics);
    expect(map.get("shared")).toBe("B");
  });
});

describe("aliasesForLabel", () => {
  it("returns alias keys for the label, excluding the normalized label itself", () => {
    const map = new Map([
      ["nlm", "NLM"],
      ["nlm-memory", "NLM"],
      ["factstore", "NLM"],
      ["navflow", "NavFlow"],
    ]);
    const result = aliasesForLabel(map, "NLM");
    expect(result).toEqual(["nlm-memory", "factstore"]);
  });

  it("excludes an alias that equals the label case-insensitively", () => {
    const map = new Map([
      ["acme", "Acme"],
      ["acme corp", "Acme"],
    ]);
    const result = aliasesForLabel(map, "Acme");
    expect(result).toEqual(["acme corp"]);
  });

  it("caps at 12 aliases", () => {
    const entries: Array<[string, string]> = Array.from({ length: 15 }, (_, i) => [`alias-${i}`, "Foo"]);
    const map = new Map(entries);
    expect(aliasesForLabel(map, "Foo")).toHaveLength(12);
  });

  it("returns empty array when no aliases exist for the label", () => {
    const map = new Map([["other", "Other"]]);
    expect(aliasesForLabel(map, "NLM")).toEqual([]);
  });

  it("returns empty array for an empty map", () => {
    expect(aliasesForLabel(new Map(), "NLM")).toEqual([]);
  });
});

