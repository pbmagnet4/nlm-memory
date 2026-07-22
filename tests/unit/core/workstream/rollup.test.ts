// tests/unit/core/workstream/rollup.test.ts
import { describe, expect, it } from "vitest";
import { rollupWorkstream, type RollupDeps } from "../../../../src/core/workstream/rollup.js";
import type { Workstream } from "../../../../src/core/workstream/model.js";

const ws = (id: string, mergedInto: string | null): Workstream => ({
  id, label: id, status: mergedInto ? "merged" : "active", mergedInto,
  createdAt: "t", updatedAt: "t", lastSessionAt: null, scope: null,
});

function deps(all: Workstream[], sessionsByWs: Record<string, string[]>): RollupDeps {
  return {
    workstreams: { listAll: async () => all, getById: async (id) => all.find((w) => w.id === id) ?? null },
    sessions: { listSessionIdsByWorkstreams: async (_tenantId, ids) => ids.flatMap((i) => sessionsByWs[i] ?? []) },
    facts: { listBySessions: async (_tenantId, sids) => sids.map((s) => ({ id: `f_${s}` })) as any },
    exemplars: { listBySessions: async (sids) => sids.map((s) => ({ id: `e_${s}` })) as any },
  };
}

describe("rollupWorkstream", () => {
  it("returns null for an unknown workstream", async () => {
    expect(await rollupWorkstream( deps([], {}), "team_local", "ws_x")).toBeNull();
  });

  it("rolls up a merged ancestor's sessions under the live survivor", async () => {
    const all = [ws("ws_old", "ws_new"), ws("ws_new", null)];
    const d = deps(all, { ws_old: ["s1"], ws_new: ["s2"] });
    const r = await rollupWorkstream( d, "team_local", "ws_new");
    expect(r!.workstream.id).toBe("ws_new");
    expect(new Set(r!.sessionIds)).toEqual(new Set(["s1", "s2"]));
    expect(new Set(r!.facts.map((f) => f.id))).toEqual(new Set(["f_s1", "f_s2"]));
  });

  it("resolves a query for the merged id to the survivor", async () => {
    const all = [ws("ws_old", "ws_new"), ws("ws_new", null)];
    const r = await rollupWorkstream( deps(all, { ws_old: ["s1"], ws_new: ["s2"] }), "team_local", "ws_old");
    expect(r!.workstream.id).toBe("ws_new");
  });
});
