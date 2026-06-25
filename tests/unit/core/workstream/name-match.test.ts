// tests/unit/core/workstream/name-match.test.ts
import { describe, it, expect } from "vitest";
import { decideWorkstreamByName } from "../../../../src/core/workstream/name-match.js";

const ws = [{ id: "ws_nlm", label: "NLM" }, { id: "ws_acme", label: "Acme" }];
const aliases = new Map([["nlm-memory", "NLM"]]);

describe("decideWorkstreamByName", () => {
  it("binds on exact seeded label (case-insensitive)", () => {
    expect(decideWorkstreamByName("nlm", ws, aliases)).toEqual({ kind: "bind", workstreamId: "ws_nlm" });
  });
  it("binds via alias map", () => {
    expect(decideWorkstreamByName("nlm-memory", ws, aliases)).toEqual({ kind: "bind", workstreamId: "ws_nlm" });
  });
  it("abstains on none/null/unknown", () => {
    expect(decideWorkstreamByName(null, ws, aliases)).toEqual({ kind: "abstain" });
    expect(decideWorkstreamByName("Zephyr", ws, aliases)).toEqual({ kind: "abstain" });
  });
});
