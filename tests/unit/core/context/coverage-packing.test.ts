import { expect, it } from "vitest";
import { buildContextBundle } from "../../../../src/core/context/context-bundle.js";
import { makeSession } from "../../../fixtures/sessions.js";
import { makeFact } from "../../../fixtures/facts.js";
import type { ContextMetadata } from "../../../../src/core/context/context-bundle.js";

const format = (value: unknown) => JSON.stringify(value, null, 2);
const query = "SQLite retrieval memory workstream";
const metadata: ContextMetadata = { intent: "lookup", scope: { status: "all" } };
const coverage = { facts: "complete", sessions: "complete", reasons: [] } as const;
it("preserves a 7948-character evidence envelope when coverage can replace optional display fields", () => {
  const source = makeSession({ id: "source", summary: "", body: "literal source evidence" });
  const pack = (summary: string, meta: ContextMetadata) => buildContextBundle(query, [],
    [{ ...source, summary, matchScore: 1, matchedIn: [], supersededBy: null }], [source], 8000, undefined, undefined, meta, format);
  const summary = "s".repeat(7948 - format(pack("", metadata)).length);
  const baseline = pack(summary, metadata);
  expect(format(baseline)).toHaveLength(7948);
  expect(baseline.sessions).toHaveLength(1);
  const candidate = pack(summary, { ...metadata, coverage });
  expect(candidate.sessions).toEqual(baseline.sessions);
  expect(candidate.omitted).toEqual(baseline.omitted);
  expect(candidate.coverage).toEqual(coverage);
  expect(format(candidate).length).toBeLessThanOrEqual(8000);
});
it("compensates coverage at the existing fact allocation without trimming fact values or source selectors", () => {
  const source = makeSession({ id: "source", summary: "short", body: "literal source evidence" });
  const fact = { ...makeFact({ id: "fact", sourceSessionId: source.id, value: "" }), matchScore: 1, matchedIn: [] };
  const pack = (value: string, meta: ContextMetadata) => buildContextBundle(query, [{ ...fact, value }],
    [{ ...source, matchScore: 1, matchedIn: [], supersededBy: null }], [source], 8000, undefined, undefined, meta, format);
  const empty = pack("", metadata);
  const factSize = format({ ...empty, sessions: [], omitted: { ...empty.omitted, sessions: 1 } }).length;
  const value = "f".repeat(3548 - factSize);
  const baseline = pack(value, metadata);
  expect(baseline.facts).toHaveLength(1);
  const candidate = pack(value, { ...metadata, coverage });
  expect(candidate.facts).toEqual(baseline.facts);
  expect(candidate.sessions).toEqual(baseline.sessions);
  expect(candidate.omitted).toEqual(baseline.omitted);
  expect(format(candidate).length).toBeLessThanOrEqual(8000);
});
