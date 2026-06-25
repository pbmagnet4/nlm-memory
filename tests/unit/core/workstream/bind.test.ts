// tests/unit/core/workstream/bind.test.ts
import { describe, expect, it } from "vitest";
import { bindSessionToWorkstream, type BindDeps, type BindInput } from "../../../../src/core/workstream/bind.js";

const baseInput: BindInput = {
  sessionId: "s1",
  label: "NLM work",
  summary: "built the scheduler",
  entities: ["NLM", "Daemon"],
  startedAt: "2026-01-01T00:00:00Z",
};

describe("bindSessionToWorkstream", () => {
  it("binds via classifier naming", async () => {
    const set: Array<[string, string, string]> = [];
    const deps: BindDeps = {
      namer: { nameWorkstream: async () => "NLM" },
      workstreams: {
        listAll: async () => [{ id: "ws_nlm", label: "NLM", status: "active", mergedInto: null, createdAt: "t", updatedAt: "t", lastSessionAt: null }],
        upsertEntities: async () => {},
        touchLastSession: async () => {},
      },
      sessions: {
        setWorkstreamBinding: async (s: string, w: string, src: string) => { set.push([s, w, src]); },
      },
      aliasToLabel: new Map<string, string>(),
    } as unknown as BindDeps;
    const r = await bindSessionToWorkstream(deps, baseInput);
    expect(r).toEqual({ workstreamId: "ws_nlm", created: false, confidence: null });
    expect(set).toEqual([["s1", "ws_nlm", "classifier"]]);
  });

  it("abstains (returns null, no binding) when classifier says none", async () => {
    const deps: BindDeps = {
      namer: { nameWorkstream: async () => null },
      workstreams: {
        listAll: async () => [{ id: "ws_nlm", label: "NLM", status: "active", mergedInto: null, createdAt: "t", updatedAt: "t", lastSessionAt: null }],
        upsertEntities: async () => {},
        touchLastSession: async () => {},
      },
      sessions: {
        setWorkstreamBinding: async () => { throw new Error("must not bind"); },
      },
      aliasToLabel: new Map<string, string>(),
    } as unknown as BindDeps;
    expect(await bindSessionToWorkstream(deps, { ...baseInput, sessionId: "s2", label: "knxt", summary: "s" })).toBeNull();
  });

  it("resolves via alias map when classifier returns an alias", async () => {
    const set: Array<[string, string, string]> = [];
    const aliasToLabel = new Map([["acme corp", "Acme"]]);
    const deps: BindDeps = {
      namer: { nameWorkstream: async () => "Acme Corp" },
      workstreams: {
        listAll: async () => [{ id: "ws_acme", label: "Acme", status: "active", mergedInto: null, createdAt: "t", updatedAt: "t", lastSessionAt: null }],
        upsertEntities: async () => {},
        touchLastSession: async () => {},
      },
      sessions: {
        setWorkstreamBinding: async (s: string, w: string, src: string) => { set.push([s, w, src]); },
      },
      aliasToLabel,
    } as unknown as BindDeps;
    const r = await bindSessionToWorkstream(deps, { ...baseInput, sessionId: "s3", label: "acme work" });
    expect(r).toEqual({ workstreamId: "ws_acme", created: false, confidence: null });
    expect(set[0]).toEqual(["s3", "ws_acme", "classifier"]);
  });

  it("returns null and does not throw on namer failure (fail open)", async () => {
    const called: string[] = [];
    const deps: BindDeps = {
      namer: { nameWorkstream: async () => { throw new Error("namer down"); } },
      workstreams: {
        listAll: async () => [],
        upsertEntities: async () => {},
        touchLastSession: async () => {},
      },
      sessions: {
        setWorkstreamBinding: async () => { called.push("bound"); },
      },
      aliasToLabel: new Map<string, string>(),
      log: () => {},
    } as unknown as BindDeps;
    expect(await bindSessionToWorkstream(deps, baseInput)).toBeNull();
    expect(called).toEqual([]);
  });
});
