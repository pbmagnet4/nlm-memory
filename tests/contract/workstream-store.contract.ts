/**
 * Backend-agnostic contract test for the WorkstreamStore port.
 *
 * Each adapter integration test imports runWorkstreamStoreContract and supplies
 * a harness that builds a fresh, migrated, empty Storage instance per test.
 * Identical assertions run against every backend. That is the only proof that
 * a new adapter (e.g. Postgres) is behaviorally equivalent to SQLite.
 *
 * Do NOT put module-level describe() blocks here. The function shape lets each
 * integration test file own its own describe naming.
 *
 * Note on seedEntity: workstream_entities has a FK to entities(canonical).
 * Each backend supplies that seed helper through the harness so this contract
 * stays adapter-agnostic. Raw session_count SQL assertions are kept inline in
 * the sqlite integration test.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Storage } from "../../src/ports/storage.js";

export interface WorkstreamStoreContractHarness {
  readonly name: string;
  setup(): Promise<Storage>;
  teardown(storage: Storage): Promise<void>;
  seedEntity(storage: Storage, canonical: string): Promise<void>;
}

export function runWorkstreamStoreContract(h: WorkstreamStoreContractHarness): void {
  describe(`WorkstreamStore contract: ${h.name}`, () => {
    let storage: Storage;

    beforeEach(async () => {
      storage = await h.setup();
    });

    afterEach(async () => {
      await h.teardown(storage);
    });

    it("creates and reads back a workstream", async () => {
      const ws = await storage.workstreams.create("team_local", { id: "ws_1", label: "NLM", scope: null });
      expect(ws).toMatchObject({ id: "ws_1", label: "NLM", status: "active", mergedInto: null });
      expect(await storage.workstreams.getById("team_local", "ws_1")).toMatchObject({ id: "ws_1" });
    });

    it("getById returns null for a missing id", async () => {
      expect(await storage.workstreams.getById("team_local", "nope")).toBeNull();
    });

    it("findByNormalizedLabel matches after collapsing whitespace", async () => {
      await storage.workstreams.create("team_local", { id: "ws_1", label: "NLM  Memory", scope: null });
      expect(await storage.workstreams.findByNormalizedLabel("team_local", "nlm memory")).toMatchObject({ id: "ws_1" });
      expect(await storage.workstreams.findByNormalizedLabel("team_local", "other")).toBeNull();
    });

    it("listAll returns every workstream", async () => {
      await storage.workstreams.create("team_local", { id: "ws_1", label: "Alpha", scope: null });
      await storage.workstreams.create("team_local", { id: "ws_2", label: "Beta", scope: null });
      const all = await storage.workstreams.listAll("team_local");
      expect(all.map((w) => w.id).sort()).toEqual(["ws_1", "ws_2"]);
    });

    it("touchLastSession updates lastSessionAt to a string matching the input instant", async () => {
      await storage.workstreams.create("team_local", { id: "ws_1", label: "NLM", scope: null });
      const atIso = "2026-06-24T00:00:00.000Z";
      await storage.workstreams.touchLastSession("team_local", "ws_1", atIso);
      const ws = await storage.workstreams.getById("team_local", "ws_1");
      expect(typeof ws!.lastSessionAt).toBe("string");
      expect(new Date(ws!.lastSessionAt!).toISOString()).toBe(new Date(atIso).toISOString());
    });

    it("setLabel updates the label", async () => {
      await storage.workstreams.create("team_local", { id: "ws_1", label: "Old", scope: null });
      await storage.workstreams.setLabel("team_local", "ws_1", "New");
      expect((await storage.workstreams.getById("team_local", "ws_1"))!.label).toBe("New");
    });

    it("setStatus updates the status", async () => {
      await storage.workstreams.create("team_local", { id: "ws_1", label: "NLM", scope: null });
      await storage.workstreams.setStatus("team_local", "ws_1", "retired");
      expect((await storage.workstreams.getById("team_local", "ws_1"))!.status).toBe("retired");
    });

    describe("upsertEntities and entitiesFor", () => {
      it("upsertEntities adds entities; entitiesFor returns them", async () => {
        await h.seedEntity(storage, "NLM");
        await h.seedEntity(storage, "Daemon");
        await storage.workstreams.create("team_local", { id: "ws_1", label: "NLM", scope: null });
        await storage.workstreams.upsertEntities("team_local", "ws_1", ["NLM", "Daemon"]);
        const map = await storage.workstreams.entitiesFor("team_local", ["ws_1"]);
        expect(new Set(map.get("ws_1"))).toEqual(new Set(["NLM", "Daemon"]));
      });

      it("entitiesFor returns undefined for an unknown workstream id", async () => {
        const map = await storage.workstreams.entitiesFor("team_local", ["nope"]);
        expect(map.get("nope")).toBeUndefined();
      });

      it("entitiesFor batches multiple workstream ids", async () => {
        await h.seedEntity(storage, "Alpha");
        await h.seedEntity(storage, "Beta");
        await storage.workstreams.create("team_local", { id: "ws_1", label: "A", scope: null });
        await storage.workstreams.create("team_local", { id: "ws_2", label: "B", scope: null });
        await storage.workstreams.upsertEntities("team_local", "ws_1", ["Alpha"]);
        await storage.workstreams.upsertEntities("team_local", "ws_2", ["Beta"]);
        const map = await storage.workstreams.entitiesFor("team_local", ["ws_1", "ws_2"]);
        expect(map.get("ws_1")).toEqual(["Alpha"]);
        expect(map.get("ws_2")).toEqual(["Beta"]);
      });
    });

    describe("candidatesByEntityOverlap", () => {
      it("returns workstreams ordered by overlap count", async () => {
        await h.seedEntity(storage, "NLM");
        await h.seedEntity(storage, "Daemon");
        await h.seedEntity(storage, "Beacon");
        await storage.workstreams.create("team_local", { id: "ws_1", label: "NLM", scope: null });
        await storage.workstreams.create("team_local", { id: "ws_2", label: "Beacon", scope: null });
        await storage.workstreams.upsertEntities("team_local", "ws_1", ["NLM", "Daemon"]);
        await storage.workstreams.upsertEntities("team_local", "ws_2", ["Beacon"]);
        const cands = await storage.workstreams.candidatesByEntityOverlap("team_local", ["NLM"], 10);
        expect(cands.map((c) => c.workstreamId)).toEqual(["ws_1"]);
        expect(new Set(cands[0]!.entities)).toEqual(new Set(["NLM", "Daemon"]));
      });

      it("returns empty array for an empty entity list", async () => {
        expect(await storage.workstreams.candidatesByEntityOverlap("team_local", [], 10)).toEqual([]);
      });
    });

    describe("merge", () => {
      it("sets merged_into, transfers entity union to target, clears source entities", async () => {
        await h.seedEntity(storage, "Alpha");
        await h.seedEntity(storage, "Beta");
        await h.seedEntity(storage, "Gamma");
        await storage.workstreams.create("team_local", { id: "ws_from", label: "From", scope: null });
        await storage.workstreams.create("team_local", { id: "ws_into", label: "Into", scope: null });
        await storage.workstreams.upsertEntities("team_local", "ws_from", ["Alpha", "Beta"]);
        await storage.workstreams.upsertEntities("team_local", "ws_into", ["Gamma"]);

        await storage.workstreams.merge("team_local", "ws_from", "ws_into");

        const from = await storage.workstreams.getById("team_local", "ws_from");
        expect(from!.status).toBe("merged");
        expect(from!.mergedInto).toBe("ws_into");

        const intoEntities = await storage.workstreams.entitiesFor("team_local", ["ws_into"]);
        expect(new Set(intoEntities.get("ws_into"))).toEqual(new Set(["Alpha", "Beta", "Gamma"]));

        const fromEntities = await storage.workstreams.entitiesFor("team_local", ["ws_from"]);
        expect(fromEntities.get("ws_from") ?? []).toHaveLength(0);
      });
    });
  });
}
