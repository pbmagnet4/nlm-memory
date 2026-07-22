import { describe, expect, it } from "vitest";
import { workstreamTopicProvider, defaultTopicProvider } from "../../../../src/core/work-digest/topics.js";
import { buildWorkDigest } from "../../../../src/core/work-digest/build-work-digest.js";

describe("workstreamTopicProvider", () => {
  it("uses the workstream label when present", () => {
    const p = workstreamTopicProvider(defaultTopicProvider);
    expect(p({ entities: ["somedotfile"], label: "x", workstreamLabel: "NLM" })).toBe("NLM");
  });
  it("falls back when no workstream label", () => {
    const p = workstreamTopicProvider(defaultTopicProvider);
    expect(p({ entities: ["Foo"], label: "x" })).toBe("foo"); // default normalizes
  });
  it("falls back on blank workstream label", () => {
    const p = workstreamTopicProvider(defaultTopicProvider);
    expect(p({ entities: ["Foo"], label: "x", workstreamLabel: "  " })).toBe("foo");
  });
});

it("attributes a bound session to its (merge-resolved) workstream label", async () => {
  const sessions = [
    { id: "s1", entities: ["dotfile"], label: "x", decisions: [], open: [], transcriptPath: "/t1", workstreamId: "ws_old" },
  ] as any;
  const deps: any = {
    store: { listByDateRange: async () => sessions },
    workstreams: { listAll: async () => [
      { id: "ws_old", label: "Old", mergedInto: "ws_new" },
      { id: "ws_new", label: "NLM", mergedInto: null },
    ] },
    readTimestamps: () => [Date.parse("2026-06-24T10:00:00Z"), Date.parse("2026-06-24T10:30:00Z")],
  };
  const d = await buildWorkDigest( deps, "team_local", "2026-06-24");
  expect(d.byTopic.map((t) => t.topic)).toContain("NLM"); // resolved through merged_into
});

it("exposes the resolved workstream_id on the topic's meta (telemetry seam §11)", async () => {
  const sessions = [
    { id: "s1", entities: ["x"], label: "x", decisions: [], open: [], transcriptPath: "/t1", workstreamId: "ws_old" },
  ] as any;
  const deps: any = {
    store: { listByDateRange: async () => sessions },
    workstreams: { listAll: async () => [
      { id: "ws_old", label: "Old", mergedInto: "ws_new" },
      { id: "ws_new", label: "NLM", mergedInto: null },
    ] },
    readTimestamps: () => [Date.parse("2026-06-24T10:00:00Z"), Date.parse("2026-06-24T10:30:00Z")],
  };
  const d = await buildWorkDigest( deps, "team_local", "2026-06-24");
  const nlm = d.byTopic.find((t) => t.topic === "NLM");
  expect(nlm?.meta?.["workstream_id"]).toBe("ws_new"); // survivor id, not ws_old
});
