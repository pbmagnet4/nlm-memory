// tests/unit/core/workstream/bind.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bindSessionToWorkstream, NAMING_CONTENT_CHARS, type BindDeps, type BindInput } from "../../../../src/core/workstream/bind.js";

const baseInput: BindInput = {
  sessionId: "s1",
  label: "NLM work",
  summary: "built the scheduler",
  entities: ["NLM", "Daemon"],
  startedAt: "2026-01-01T00:00:00Z",
  scope: null,
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
        setWorkstreamBinding: async (_t: string, s: string, w: string, src: string) => { set.push([s, w, src]); },
      },
      aliasToLabel: new Map<string, string>(),
    } as unknown as BindDeps;
    const r = await bindSessionToWorkstream( deps, "team_local", baseInput);
    expect(r).toEqual({ workstreamId: "ws_nlm" });
    expect(set).toEqual([["s1", "ws_nlm", "classifier"]]);
  });

  it("binds with backfill source when provided", async () => {
    const set: Array<[string, string, string]> = [];
    const deps: BindDeps = {
      namer: { nameWorkstream: async () => "NLM" },
      workstreams: {
        listAll: async () => [{ id: "ws_nlm", label: "NLM", status: "active", mergedInto: null, createdAt: "t", updatedAt: "t", lastSessionAt: null }],
        upsertEntities: async () => {},
        touchLastSession: async () => {},
      },
      sessions: {
        setWorkstreamBinding: async (_t: string, s: string, w: string, src: string) => { set.push([s, w, src]); },
      },
      aliasToLabel: new Map<string, string>(),
      source: "backfill",
    } as unknown as BindDeps;
    const r = await bindSessionToWorkstream( deps, "team_local", baseInput);
    expect(r).toEqual({ workstreamId: "ws_nlm" });
    expect(set).toEqual([["s1", "ws_nlm", "backfill"]]);
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
    expect(await bindSessionToWorkstream( deps, "team_local", { ...baseInput, sessionId: "s2", label: "Zephyr", summary: "s" })).toBeNull();
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
        setWorkstreamBinding: async (_t: string, s: string, w: string, src: string) => { set.push([s, w, src]); },
      },
      aliasToLabel,
    } as unknown as BindDeps;
    const r = await bindSessionToWorkstream( deps, "team_local", { ...baseInput, sessionId: "s3", label: "acme work" });
    expect(r).toEqual({ workstreamId: "ws_acme" });
    expect(set[0]).toEqual(["s3", "ws_acme", "classifier"]);
  });

  it("passes body content to namer when body is present", async () => {
    let capturedContent = "";
    const deps: BindDeps = {
      namer: {
        nameWorkstream: async (content: string) => {
          capturedContent = content;
          return "NLM";
        },
      },
      workstreams: {
        listAll: async () => [{ id: "ws_nlm", label: "NLM", status: "active", mergedInto: null, createdAt: "t", updatedAt: "t", lastSessionAt: null }],
        upsertEntities: async () => {},
        touchLastSession: async () => {},
      },
      sessions: {
        setWorkstreamBinding: async () => {},
      },
      aliasToLabel: new Map<string, string>(),
    } as unknown as BindDeps;
    const bodyText = "full body transcript content for NLM session";
    await bindSessionToWorkstream( deps, "team_local", { ...baseInput, body: bodyText });
    expect(capturedContent).toContain(bodyText);
    expect(capturedContent).not.toContain("built the scheduler");
  });

  it("falls back to summary when body is absent", async () => {
    let capturedContent = "";
    const deps: BindDeps = {
      namer: {
        nameWorkstream: async (content: string) => {
          capturedContent = content;
          return "NLM";
        },
      },
      workstreams: {
        listAll: async () => [{ id: "ws_nlm", label: "NLM", status: "active", mergedInto: null, createdAt: "t", updatedAt: "t", lastSessionAt: null }],
        upsertEntities: async () => {},
        touchLastSession: async () => {},
      },
      sessions: {
        setWorkstreamBinding: async () => {},
      },
      aliasToLabel: new Map<string, string>(),
    } as unknown as BindDeps;
    await bindSessionToWorkstream( deps, "team_local", baseInput);
    expect(capturedContent).toContain("built the scheduler");
  });

  it("falls back to summary when body is an empty string", async () => {
    let capturedContent = "";
    const deps: BindDeps = {
      namer: {
        nameWorkstream: async (content: string) => {
          capturedContent = content;
          return "NLM";
        },
      },
      workstreams: {
        listAll: async () => [{ id: "ws_nlm", label: "NLM", status: "active", mergedInto: null, createdAt: "t", updatedAt: "t", lastSessionAt: null }],
        upsertEntities: async () => {},
        touchLastSession: async () => {},
      },
      sessions: {
        setWorkstreamBinding: async () => {},
      },
      aliasToLabel: new Map<string, string>(),
    } as unknown as BindDeps;
    await bindSessionToWorkstream( deps, "team_local", { ...baseInput, body: "" });
    expect(capturedContent).toContain("built the scheduler");
  });

  it("passes label-only hints to namer", async () => {
    let capturedHints: ReadonlyArray<{ label: string }> = [];
    const deps: BindDeps = {
      namer: {
        nameWorkstream: async (_content: string, hints: ReadonlyArray<{ label: string }>) => {
          capturedHints = hints;
          return "NLM";
        },
      },
      workstreams: {
        listAll: async () => [{ id: "ws_nlm", label: "NLM", status: "active", mergedInto: null, createdAt: "t", updatedAt: "t", lastSessionAt: null }],
        upsertEntities: async () => {},
        touchLastSession: async () => {},
      },
      sessions: {
        setWorkstreamBinding: async () => {},
      },
      aliasToLabel: new Map([["nlm-memory", "NLM"], ["nlm", "NLM"]]),
    } as unknown as BindDeps;
    await bindSessionToWorkstream( deps, "team_local", baseInput);
    expect(capturedHints).toHaveLength(1);
    expect(capturedHints[0]).toEqual({ label: "NLM" });
  });

  it("truncates body to NAMING_CONTENT_CHARS", async () => {
    let capturedContent = "";
    const deps: BindDeps = {
      namer: {
        nameWorkstream: async (content: string) => {
          capturedContent = content;
          return "NLM";
        },
      },
      workstreams: {
        listAll: async () => [{ id: "ws_nlm", label: "NLM", status: "active", mergedInto: null, createdAt: "t", updatedAt: "t", lastSessionAt: null }],
        upsertEntities: async () => {},
        touchLastSession: async () => {},
      },
      sessions: {
        setWorkstreamBinding: async () => {},
      },
      aliasToLabel: new Map<string, string>(),
    } as unknown as BindDeps;
    const longBody = "x".repeat(NAMING_CONTENT_CHARS + 1000);
    await bindSessionToWorkstream( deps, "team_local", { ...baseInput, body: longBody });
    // label + newline + body slice; total body portion should not exceed cap
    const bodyPortion = capturedContent.slice(capturedContent.indexOf("\n") + 1);
    expect(bodyPortion.length).toBe(NAMING_CONTENT_CHARS);
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
    expect(await bindSessionToWorkstream( deps, "team_local", baseInput)).toBeNull();
    expect(called).toEqual([]);
  });

  describe("namer hint filtering (Fix C)", () => {
    const prevStamp = process.env["NLM_SCOPE_STAMP"];
    beforeEach(() => { process.env["NLM_SCOPE_STAMP"] = "1"; });
    afterEach(() => {
      if (prevStamp === undefined) delete process.env["NLM_SCOPE_STAMP"];
      else process.env["NLM_SCOPE_STAMP"] = prevStamp;
    });

    it("with flag on, passes only in-scope labels as hints to the namer", async () => {
      let capturedHints: ReadonlyArray<{ label: string }> = [];
      const all = [
        { id: "ws_a", label: "scope-a-work", scope: "scope-a", status: "active" as const, mergedInto: null, createdAt: "t", updatedAt: "t", lastSessionAt: null },
        { id: "ws_b", label: "scope-b-work", scope: "scope-b", status: "active" as const, mergedInto: null, createdAt: "t", updatedAt: "t", lastSessionAt: null },
      ];
      const deps: BindDeps = {
        namer: {
          nameWorkstream: async (_content: string, hints: ReadonlyArray<{ label: string }>) => {
            capturedHints = hints;
            return "scope-a-work";
          },
        },
        workstreams: {
          listAll: async () => all,
          upsertEntities: async () => {},
          touchLastSession: async () => {},
        },
        sessions: { setWorkstreamBinding: async () => {} },
        aliasToLabel: new Map<string, string>(),
      } as unknown as BindDeps;
      await bindSessionToWorkstream( deps, "team_local", { ...baseInput, scope: "scope-a" });
      expect(capturedHints).toHaveLength(1);
      expect(capturedHints[0]).toEqual({ label: "scope-a-work" });
    });

    it("with flag off, passes all labels as hints to the namer", async () => {
      delete process.env["NLM_SCOPE_STAMP"];
      let capturedHints: ReadonlyArray<{ label: string }> = [];
      const all = [
        { id: "ws_a", label: "scope-a-work", scope: "scope-a", status: "active" as const, mergedInto: null, createdAt: "t", updatedAt: "t", lastSessionAt: null },
        { id: "ws_b", label: "scope-b-work", scope: "scope-b", status: "active" as const, mergedInto: null, createdAt: "t", updatedAt: "t", lastSessionAt: null },
      ];
      const deps: BindDeps = {
        namer: {
          nameWorkstream: async (_content: string, hints: ReadonlyArray<{ label: string }>) => {
            capturedHints = hints;
            return "scope-a-work";
          },
        },
        workstreams: {
          listAll: async () => all,
          upsertEntities: async () => {},
          touchLastSession: async () => {},
        },
        sessions: { setWorkstreamBinding: async () => {} },
        aliasToLabel: new Map<string, string>(),
      } as unknown as BindDeps;
      await bindSessionToWorkstream( deps, "team_local", { ...baseInput, scope: "scope-a" });
      expect(capturedHints).toHaveLength(2);
      expect(capturedHints.map((h) => h.label).sort()).toEqual(["scope-a-work", "scope-b-work"]);
    });
  });
});
