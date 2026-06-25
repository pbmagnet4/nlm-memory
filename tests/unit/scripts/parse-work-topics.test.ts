import { describe, expect, it } from "vitest";
import { parseWorkTopics } from "../../../scripts/seed-workstreams.js";

describe("parseWorkTopics", () => {
  it("parses the object-map shape", () => {
    const out = parseWorkTopics({ "Project Alpha": ["alpha", "a-cli"], "Project Beta": ["beta"] });
    expect(out).toEqual([
      { label: "Project Alpha", entities: ["alpha", "a-cli"] },
      { label: "Project Beta", entities: ["beta"] },
    ]);
  });
  it("parses the alias-map shape (string values), grouping aliases under their canonical", () => {
    const out = parseWorkTopics({ "nlm-memory": "NLM", nlm: "NLM", beacon: "Beacon" });
    const byLabel = new Map(out.map((w) => [w.label, [...w.entities].sort()]));
    expect(byLabel.get("NLM")).toEqual(["NLM", "nlm", "nlm-memory"]);
    expect(byLabel.get("Beacon")).toEqual(["Beacon", "beacon"]);
  });
  it("parses the array shape", () => {
    const out = parseWorkTopics([{ label: "Gamma", entities: ["g1", "g2"] }]);
    expect(out).toEqual([{ label: "Gamma", entities: ["g1", "g2"] }]);
  });
  it("throws on an unrecognized shape", () => {
    expect(() => parseWorkTopics(42)).toThrow();
    expect(() => parseWorkTopics([{ nope: true }])).toThrow();
  });
});
