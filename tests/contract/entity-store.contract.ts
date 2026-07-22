/**
 * Backend-agnostic contract test for the EntityStore port.
 *
 * Each adapter integration test imports runEntityStoreContract and supplies
 * a harness that builds a fresh, migrated, empty Storage instance per test.
 * Identical assertions run against every backend.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Storage } from "../../src/ports/storage.js";

export interface EntityStoreContractHarness {
  readonly name: string;
  setup(): Promise<Storage>;
  teardown(storage: Storage): Promise<void>;
  seedSession(storage: Storage, sessionId: string, startedAt: string): Promise<void>;
  seedEntity(
    storage: Storage,
    canonical: string,
    opts: { sessionIds?: string[]; firstSeen?: string; lastSeen?: string; status?: string },
  ): Promise<void>;
  seedVariant(storage: Storage, variant: string, canonical: string): Promise<void>;
  getEntityRow(storage: Storage, canonical: string): Promise<{
    status: string;
    sessionCount: number;
    firstSeenSession: string | null;
    lastSeenSession: string | null;
  } | null>;
  getVariantRow(storage: Storage, variant: string): Promise<{ canonical: string } | null>;
  getSessionEntityLinks(storage: Storage, entityCanonical: string): Promise<string[]>;
}

export function runEntityStoreContract(h: EntityStoreContractHarness): void {
  describe(`EntityStore contract: ${h.name}`, () => {
    let storage: Storage;

    beforeEach(async () => {
      storage = await h.setup();
    });

    afterEach(async () => {
      await h.teardown(storage);
    });

    describe("merge happy path with session overlap dedup", () => {
      it("moves session_entities from source to target, deduping shared sessions", async () => {
        await h.seedSession(storage, "sess_shared", "2026-01-01T00:00:00Z");
        await h.seedSession(storage, "sess_source_only", "2026-01-02T00:00:00Z");
        await h.seedEntity(storage, "source-ent", { sessionIds: ["sess_shared", "sess_source_only"] });
        await h.seedEntity(storage, "target-ent", { sessionIds: ["sess_shared"] });

        await storage.entities.merge("team_local", "source-ent", "target-ent");

        const targetLinks = await h.getSessionEntityLinks(storage, "target-ent");
        expect(targetLinks.sort()).toEqual(["sess_shared", "sess_source_only"].sort());

        const sourceLinks = await h.getSessionEntityLinks(storage, "source-ent");
        expect(sourceLinks).toEqual([]);
      });
    });

    describe("exact count recompute", () => {
      it("heals a drifted session_count on the target", async () => {
        await h.seedSession(storage, "sess_a", "2026-01-01T00:00:00Z");
        await h.seedSession(storage, "sess_b", "2026-01-02T00:00:00Z");
        await h.seedEntity(storage, "source-ent", { sessionIds: ["sess_a"] });
        await h.seedEntity(storage, "target-ent", { sessionIds: ["sess_b"] });

        await storage.entities.merge("team_local", "source-ent", "target-ent");

        const row = await h.getEntityRow(storage, "target-ent");
        expect(row?.sessionCount).toBe(2);
      });

      it("source session_count is 0 after merge", async () => {
        await h.seedSession(storage, "sess_a", "2026-01-01T00:00:00Z");
        await h.seedEntity(storage, "source-ent", { sessionIds: ["sess_a"] });
        await h.seedEntity(storage, "target-ent", { sessionIds: [] });

        await storage.entities.merge("team_local", "source-ent", "target-ent");

        const row = await h.getEntityRow(storage, "source-ent");
        expect(row?.sessionCount).toBe(0);
      });
    });

    describe("variant written", () => {
      it("inserts entity_variants row with source -> target mapping", async () => {
        await h.seedEntity(storage, "source-ent", {});
        await h.seedEntity(storage, "target-ent", {});

        await storage.entities.merge("team_local", "source-ent", "target-ent");

        const v = await h.getVariantRow(storage, "source-ent");
        expect(v).not.toBeNull();
        expect(v?.canonical).toBe("target-ent");
      });
    });

    describe("source retired in place", () => {
      it("sets source status=retired and session_count=0", async () => {
        await h.seedSession(storage, "sess_a", "2026-01-01T00:00:00Z");
        await h.seedEntity(storage, "source-ent", { sessionIds: ["sess_a"] });
        await h.seedEntity(storage, "target-ent", {});

        await storage.entities.merge("team_local", "source-ent", "target-ent");

        const row = await h.getEntityRow(storage, "source-ent");
        expect(row?.status).toBe("retired");
        expect(row?.sessionCount).toBe(0);
      });

      it("source entity row is preserved, not deleted", async () => {
        await h.seedEntity(storage, "source-ent", {});
        await h.seedEntity(storage, "target-ent", {});

        await storage.entities.merge("team_local", "source-ent", "target-ent");

        const row = await h.getEntityRow(storage, "source-ent");
        expect(row).not.toBeNull();
      });
    });

    describe("variants re-pointed", () => {
      it("re-points existing source variants to the target after merge", async () => {
        await h.seedEntity(storage, "source-ent", {});
        await h.seedEntity(storage, "target-ent", {});
        await h.seedVariant(storage, "old-alias", "source-ent");

        await storage.entities.merge("team_local", "source-ent", "target-ent");

        const v = await h.getVariantRow(storage, "old-alias");
        expect(v?.canonical).toBe("target-ent");
      });
    });

    describe("first_seen / last_seen widening", () => {
      it("widens first_seen to the chronologically earlier session", async () => {
        await h.seedSession(storage, "sess_early", "2026-01-01T00:00:00Z");
        await h.seedSession(storage, "sess_late", "2026-06-01T00:00:00Z");
        await h.seedEntity(storage, "source-ent", { firstSeen: "sess_late", lastSeen: "sess_late" });
        await h.seedEntity(storage, "target-ent", { firstSeen: "sess_early", lastSeen: "sess_early" });

        await storage.entities.merge("team_local", "source-ent", "target-ent");

        const row = await h.getEntityRow(storage, "target-ent");
        expect(row?.firstSeenSession).toBe("sess_early");
        expect(row?.lastSeenSession).toBe("sess_late");
      });

      it("widens last_seen to the chronologically later session", async () => {
        await h.seedSession(storage, "sess_early", "2026-01-01T00:00:00Z");
        await h.seedSession(storage, "sess_late", "2026-06-01T00:00:00Z");
        await h.seedEntity(storage, "source-ent", { firstSeen: "sess_early", lastSeen: "sess_early" });
        await h.seedEntity(storage, "target-ent", { firstSeen: "sess_late", lastSeen: "sess_late" });

        await storage.entities.merge("team_local", "source-ent", "target-ent");

        const row = await h.getEntityRow(storage, "target-ent");
        expect(row?.firstSeenSession).toBe("sess_early");
        expect(row?.lastSeenSession).toBe("sess_late");
      });

      it("leaves target first/last_seen unchanged when the source was never seen (NULL columns)", async () => {
        // A NULL first/last_seen rides through the widening subquery's IN list;
        // SQL three-valued logic must skip it rather than clobber the target.
        await h.seedSession(storage, "sess_a", "2026-03-01T00:00:00Z");
        await h.seedEntity(storage, "source-ent", {});
        await h.seedEntity(storage, "target-ent", { firstSeen: "sess_a", lastSeen: "sess_a" });

        await storage.entities.merge("team_local", "source-ent", "target-ent");

        const row = await h.getEntityRow(storage, "target-ent");
        expect(row?.firstSeenSession).toBe("sess_a");
        expect(row?.lastSeenSession).toBe("sess_a");
      });
    });

    describe("error cases", () => {
      it("throws when target entity is missing", async () => {
        await h.seedEntity(storage, "source-ent", {});

        await expect(storage.entities.merge("team_local", "source-ent", "nonexistent")).rejects.toThrow(
          /target entity not found/,
        );
      });

      it("throws when target entity is retired", async () => {
        await h.seedEntity(storage, "source-ent", {});
        await h.seedEntity(storage, "intermediate", {});
        await h.seedEntity(storage, "retired-target", {});
        await storage.entities.merge("team_local", "retired-target", "intermediate");

        await expect(storage.entities.merge("team_local", "source-ent", "retired-target")).rejects.toThrow(
          /target entity is retired/,
        );
      });

      it("throws when source entity is missing", async () => {
        await h.seedEntity(storage, "target-ent", {});

        await expect(storage.entities.merge("team_local", "nonexistent", "target-ent")).rejects.toThrow(
          /source entity not found/,
        );
      });
    });
  });
}
