/**
 * Backend-agnostic contract for the SignalStore port. Each adapter integration
 * test supplies a harness that builds a fresh, migrated, empty Storage.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Storage } from "../../src/ports/storage.js";
import { makeSignal } from "../fixtures/signals.js";

export interface SignalStoreContractHarness {
  readonly name: string;
  setup(): Promise<Storage>;
  teardown(storage: Storage): Promise<void>;
}

export function runSignalStoreContract(h: SignalStoreContractHarness): void {
  describe(`SignalStore contract: ${h.name}`, () => {
    let storage: Storage;

    beforeEach(async () => { storage = await h.setup(); });
    afterEach(async () => { await h.teardown(storage); });

    it("inserts and lists a signal round-trip", async () => {
      const s = makeSignal({ id: "sig_a" });
      await storage.signals.insert("team_local", s);
      const rows = await storage.signals.listForAggregation("team_local", { installScope: "install-test" });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(s);
    });

    it("insert is idempotent on duplicate id", async () => {
      await storage.signals.insert("team_local", makeSignal({ id: "sig_dup", outcome: "fail" }));
      await storage.signals.insert("team_local", makeSignal({ id: "sig_dup", outcome: "pass" }));
      const rows = await storage.signals.listForAggregation("team_local", { installScope: "install-test" });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.outcome).toBe("fail"); // first write wins
    });

    it("insertMany skips duplicates and inserts the rest", async () => {
      await storage.signals.insert("team_local", makeSignal({ id: "sig_x" }));
      await storage.signals.insertMany("team_local", [
        makeSignal({ id: "sig_x" }),
        makeSignal({ id: "sig_y" }),
      ]);
      const rows = await storage.signals.listForAggregation("team_local", { installScope: "install-test" });
      expect(rows.map((r) => r.id).sort()).toEqual(["sig_x", "sig_y"]);
    });

    it("filters by repo, model, kind, and sinceTs", async () => {
      await storage.signals.insertMany("team_local", [
        makeSignal({ id: "s1", repo: "/a", model: "m1", kind: "gate", ts: "2026-06-01T00:00:00.000Z" }),
        makeSignal({ id: "s2", repo: "/b", model: "m1", kind: "gate", ts: "2026-06-09T00:00:00.000Z" }),
        makeSignal({ id: "s3", repo: "/a", model: "m2", kind: "test", ts: "2026-06-09T00:00:00.000Z" }),
      ]);
      const byRepo = await storage.signals.listForAggregation("team_local", { installScope: "install-test", repo: "/a" });
      expect(byRepo.map((r) => r.id).sort()).toEqual(["s1", "s3"]);
      const since = await storage.signals.listForAggregation("team_local", { installScope: "install-test", sinceTs: "2026-06-05T00:00:00.000Z" });
      expect(since.map((r) => r.id).sort()).toEqual(["s2", "s3"]);
      const isolated = await storage.signals.listForAggregation("team_local", { installScope: "other-install" });
      expect(isolated).toHaveLength(0);
    });

    it("countSince and pruneOlderThan operate on ts", async () => {
      await storage.signals.insertMany("team_local", [
        makeSignal({ id: "old", ts: "2026-01-01T00:00:00.000Z" }),
        makeSignal({ id: "new", ts: "2026-06-09T00:00:00.000Z" }),
      ]);
      expect(await storage.signals.countSince("team_local", "install-test", "2026-06-01T00:00:00.000Z")).toBe(1);
      const pruned = await storage.signals.pruneOlderThan("team_local", "2026-06-01T00:00:00.000Z");
      expect(pruned).toBe(1);
      const rest = await storage.signals.listForAggregation("team_local", { installScope: "install-test" });
      expect(rest.map((r) => r.id)).toEqual(["new"]);
    });
  });
}
