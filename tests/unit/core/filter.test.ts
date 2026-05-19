import { describe, expect, it } from "vitest";
import { applyFilter } from "../../../src/core/recall/filter.js";
import { makeSession } from "../../fixtures/sessions.js";

describe("applyFilter", () => {
  const noDecisionsNoOpen = makeSession({ id: "a", entities: ["Whtnxt"] });
  const onlyDecisions = makeSession({ id: "b", entities: ["NLE Memory"], decisions: ["picked Hono"] });
  const onlyOpen = makeSession({ id: "c", entities: ["NLE Memory"], open: ["pgvector later"] });
  const both = makeSession({
    id: "d",
    entities: ["NLE Memory", "Whtnxt"],
    decisions: ["use SQLite + sqlite-vec"],
    open: ["Tauri or Electron"],
  });
  const corpus = [noDecisionsNoOpen, onlyDecisions, onlyOpen, both];

  it("returns input unchanged when filter is empty", () => {
    expect(applyFilter(corpus, {})).toEqual(corpus);
  });

  it("filters by entity tag", () => {
    const result = applyFilter(corpus, { entity: "NLE Memory" });
    expect(result.map((s) => s.id)).toEqual(["b", "c", "d"]);
  });

  it("filters by kind=decision (drops sessions with no decisions)", () => {
    const result = applyFilter(corpus, { kind: "decision" });
    expect(result.map((s) => s.id)).toEqual(["b", "d"]);
  });

  it("filters by kind=open (drops sessions with no open questions)", () => {
    const result = applyFilter(corpus, { kind: "open" });
    expect(result.map((s) => s.id)).toEqual(["c", "d"]);
  });

  it("combines entity and kind constraints (AND semantics)", () => {
    const result = applyFilter(corpus, { entity: "Whtnxt", kind: "decision" });
    expect(result.map((s) => s.id)).toEqual(["d"]);
  });
});
