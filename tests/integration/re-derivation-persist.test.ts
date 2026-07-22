/**
 * corpus monitor -> pairs cache -> outcome rollup (#405): the monitor's
 * persist step (`persistReDerivationPairs`, `src/cli/nlm.ts`) writes a real
 * `ReDerivationPair` to the cache file, `buildSqliteOutcomeDeps` reads it
 * back from that same file instead of recomputing `computeReDerivationRate`
 * inline, and `deriveOutcome` surfaces the "re-derived-later" verdict.
 */

import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import { persistReDerivationPairs } from "../../src/cli/nlm.js";
import { buildSqliteOutcomeDeps } from "../../src/core/storage/sqlite-outcome-store.js";
import { deriveOutcome } from "../../src/core/outcome/rollup.js";
import { makeSession } from "../fixtures/sessions.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

describe("corpus monitor persists re-derivation pairs for the outcome rollup", () => {
  let tmp: string;
  let storage: SqliteStorage;
  let pairsPath: string;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-rederive-persist-"));
    storage = SqliteStorage.create({
      dbPath: join(tmp, "canonical.sqlite"),
      migrationsDir: MIGRATIONS_DIR,
    });
    await storage.init();
    pairsPath = join(tmp, "re-derivation-pairs.json");
  });

  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("round-trips a known re-derivation pair from monitor persist to a re-derived-later verdict", async () => {
    // Sessions never end (endedAt: null) so the rollup's held-after-14-days
    // check (which would otherwise win over re-derivation) is skipped.
    storage.sessions.insertSessionForTest(
      makeSession({
        id: "a",
        startedAt: "2026-01-01T00:00:00Z",
        endedAt: null,
        status: "closed",
        entities: ["pgvector"],
        decisions: ["use pgvector over qdrant"],
      }),
    );
    storage.sessions.insertSessionForTest(
      makeSession({
        id: "b",
        startedAt: "2026-01-20T00:00:00Z",
        endedAt: null,
        status: "closed",
        entities: ["pgvector"],
        decisions: ["use pgvector over qdrant"],
      }),
    );

    const report = await persistReDerivationPairs(storage.rawDb(), pairsPath, 3650);
    expect(report.pairs).toEqual([{ a: "a", b: "b", sharedEntities: ["pgvector"], jaccard: 1 }]);

    const persisted = JSON.parse(readFileSync(pairsPath, "utf8"));
    expect(persisted).toEqual(report.pairs);

    const deps = await buildSqliteOutcomeDeps(storage.rawDb(), { reDerivationPairsPath: pairsPath });
    expect(deps.reDerivationPairs).toEqual(report.pairs);

    const verdictA = await deriveOutcome("team_local", "a", deps);
    expect(verdictA).toEqual({
      verdict: "re-derived-later",
      tier: "B",
      confidence: "medium",
      evidence: ["re-derivation-pair:b"],
    });

    const verdictB = await deriveOutcome("team_local", "b", deps);
    expect(verdictB.verdict).toBe("re-derived-later");
    expect(verdictB.evidence).toEqual(["re-derivation-pair:a"]);
  });

  it("falls back to unobserved (not re-derived-later) when the pairs cache is missing", async () => {
    storage.sessions.insertSessionForTest(
      makeSession({ id: "a", endedAt: null, status: "closed", entities: ["pgvector"] }),
    );
    const deps = await buildSqliteOutcomeDeps(storage.rawDb(), {
      reDerivationPairsPath: join(tmp, "nonexistent-pairs.json"),
    });
    const verdict = await deriveOutcome("team_local", "a", deps);
    expect(verdict.verdict).toBe("unobserved");
  });

  it("falls back to unobserved when the pairs cache is corrupt", async () => {
    storage.sessions.insertSessionForTest(
      makeSession({ id: "a", endedAt: null, status: "closed", entities: ["pgvector"] }),
    );
    writeFileSync(pairsPath, "{not valid json", "utf8");
    const deps = await buildSqliteOutcomeDeps(storage.rawDb(), { reDerivationPairsPath: pairsPath });
    expect(deps.reDerivationPairs).toEqual([]);
    const verdict = await deriveOutcome("team_local", "a", deps);
    expect(verdict.verdict).toBe("unobserved");
  });
});
