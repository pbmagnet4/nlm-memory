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
  it("parses the array shape", () => {
    const out = parseWorkTopics([{ label: "Gamma", entities: ["g1", "g2"] }]);
    expect(out).toEqual([{ label: "Gamma", entities: ["g1", "g2"] }]);
  });
  it("throws on an unrecognized shape", () => {
    expect(() => parseWorkTopics(42)).toThrow();
    expect(() => parseWorkTopics([{ nope: true }])).toThrow();
  });
});
