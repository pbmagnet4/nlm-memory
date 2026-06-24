// tests/unit/core/workstream/bind.test.ts
import { describe, expect, it, vi } from "vitest";
import { bindSessionToWorkstream, type BindDeps, type BindInput } from "../../../../src/core/workstream/bind.js";

const input: BindInput = { sessionId: "s_new", label: "NLM workstream work", summary: "built the matcher", entities: ["NLM", "Daemon"], startedAt: "2026-06-24T00:00:00Z" };

function fakeDeps(over: Partial<BindDeps> & { existing?: Array<{ id: string; label: string; entities: string[] }>; neighbors?: Array<{ sessionId: string; distance: number; ws: string | null }> } = {}): { deps: BindDeps; setBinding: ReturnType<typeof vi.fn>; created: string[] } {
  const existing = over.existing ?? [];
  const neighbors = over.neighbors ?? [];
  const created: string[] = [];
  const setBinding = vi.fn(async () => {});
  const wsById = new Map(existing.map((w) => [w.id, { id: w.id, label: w.label, status: "active", mergedInto: null, createdAt: "t", updatedAt: "t", lastSessionAt: null }]));
  const entById = new Map(existing.map((w) => [w.id, w.entities]));
  const deps: BindDeps = {
    workstreams: {
      create: async ({ id, label }) => { created.push(id); const w = { id, label, status: "active" as const, mergedInto: null, createdAt: "t", updatedAt: "t", lastSessionAt: null }; wsById.set(id, w); return w; },
      getById: async (id) => (wsById.get(id) as any) ?? null,
      findByNormalizedLabel: async (n) => { for (const w of wsById.values()) if (w.label.trim().toLowerCase().replace(/\s+/g, " ") === n) return w as any; return null; },
      listAll: async () => [...wsById.values()] as any,
      touchLastSession: async () => {},
      upsertEntities: async () => {},
      entitiesFor: async (ids) => new Map(ids.map((i) => [i, entById.get(i) ?? []])),
      candidatesByEntityOverlap: async (ents) => existing.filter((w) => w.entities.some((e) => ents.includes(e))).map((w) => ({ workstreamId: w.id, entities: w.entities })),
    },
    sessions: {
      setWorkstreamBinding: setBinding,
      semanticSearch: async () => neighbors.map((n) => ({ sessionId: n.sessionId, distance: n.distance })),
      getWorkstreamIds: async (ids: string[]) => new Map(ids.map((i) => [i, neighbors.find((n) => n.sessionId === i)?.ws ?? null])),
    } as any,
    embedder: { embed: async () => ({ vector: new Float32Array([1, 0, 0]), model: "fake" }) },
    thresholds: { high: 0.55, low: 0.3 },
    weights: { semantic: 0.5, entity: 0.5 },
    pickAmbiguous: over.pickAmbiguous ?? (async () => null),
    log: () => {},
  };
  return { deps, setBinding, created };
}

describe("bindSessionToWorkstream", () => {
  it("binds to a strong semantic+entity match without creating", async () => {
    const { deps, setBinding, created } = fakeDeps({
      existing: [{ id: "ws_nlm", label: "NLM", entities: ["NLM", "Daemon"] }],
      neighbors: [{ sessionId: "s_old", distance: 0.1, ws: "ws_nlm" }],
    });
    const r = await bindSessionToWorkstream(deps, input);
    expect(r).toMatchObject({ workstreamId: "ws_nlm", created: false });
    expect(created).toEqual([]);
    expect(setBinding).toHaveBeenCalledWith("s_new", "ws_nlm", "classifier", expect.any(Number));
  });

  it("creates a fresh workstream when nothing matches", async () => {
    const { deps, created } = fakeDeps({ existing: [], neighbors: [] });
    const r = await bindSessionToWorkstream(deps, input);
    expect(r!.created).toBe(true);
    expect(created.length).toBe(1);
  });

  it("excludes the session itself from neighbors", async () => {
    const { deps, created } = fakeDeps({
      existing: [{ id: "ws_nlm", label: "NLM", entities: ["X"] }],
      neighbors: [{ sessionId: "s_new", distance: 0.0, ws: "ws_nlm" }], // self
    });
    const r = await bindSessionToWorkstream(deps, input);
    // self excluded => no semantic signal => entity overlap (NLM/Daemon vs X) ~0 => create
    expect(r!.created).toBe(true);
    expect(created.length).toBe(1);
  });

  it("dedups on create via normalized label", async () => {
    const { deps, created } = fakeDeps({ existing: [{ id: "ws_nlm", label: "N L M", entities: ["Z"] }] });
    const r = await bindSessionToWorkstream({ ...deps }, { ...input, label: "n l m", entities: ["Q"] });
    expect(r!.workstreamId).toBe("ws_nlm");
    expect(r!.created).toBe(false);
    expect(created).toEqual([]);
  });

  it("ambiguous band asks pickAmbiguous and binds its choice", async () => {
    const { deps, setBinding } = fakeDeps({
      existing: [{ id: "ws_a", label: "A", entities: ["NLM"] }, { id: "ws_b", label: "B", entities: ["Daemon"] }],
      neighbors: [{ sessionId: "s_old", distance: 0.9, ws: "ws_a" }],
      pickAmbiguous: async () => "ws_b",
    });
    const r = await bindSessionToWorkstream(deps, input);
    expect(r!.workstreamId).toBe("ws_b");
    expect(setBinding).toHaveBeenCalledWith("s_new", "ws_b", "classifier", expect.any(Number));
  });

  it("returns null and does not throw on embedder failure (fail open)", async () => {
    const { deps, setBinding } = fakeDeps({});
    (deps.embedder as any).embed = async () => { throw new Error("embedder down"); };
    expect(await bindSessionToWorkstream(deps, input)).toBeNull();
    expect(setBinding).not.toHaveBeenCalled();
  });
});
