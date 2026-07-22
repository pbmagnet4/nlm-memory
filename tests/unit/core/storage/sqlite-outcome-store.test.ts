import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../../../../src/core/storage/sqlite-storage.js";
import {
  SqliteOutcomeCitationReader,
  SqliteOutcomeEdgeReader,
  SqliteOutcomeSessionReader,
  SqliteOutcomeSignalReader,
  buildSqliteOutcomeDeps,
  loadOutcomeCoverageInput,
} from "../../../../src/core/storage/sqlite-outcome-store.js";
import { makeSession } from "../../../fixtures/sessions.js";
import type { Signal } from "../../../../src/shared/types.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../../../migrations");

function makeSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: `sig_${Math.random().toString(36).slice(2)}`,
    v: 1,
    installScope: "install-test",
    kind: "review",
    producer: "mcp",
    outcome: "pass",
    model: "test-model",
    repo: "test-repo",
    step: null,
    detail: null,
    sessionId: null,
    scope: null,
    ts: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("sqlite outcome adapters", () => {
  let tmp: string;
  let storage: SqliteStorage;
  let citationLogPath: string;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-outcome-store-"));
    storage = SqliteStorage.create({
      dbPath: join(tmp, "canonical.sqlite"),
      migrationsDir: MIGRATIONS_DIR,
    });
    await storage.init();
    citationLogPath = join(tmp, "citation-log.jsonl");
  });

  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  describe("SqliteOutcomeSessionReader", () => {
    it("returns the narrow session projection without selecting body", async () => {
      storage.sessions.insertSessionForTest(
        makeSession({ id: "s1", endedAt: "2026-01-01T00:00:00.000Z", status: "closed", body: "x".repeat(50_000) }),
      );
      const reader = new SqliteOutcomeSessionReader(storage.rawDb());
      const result = await reader.getById("team_local", "s1");
      expect(result).toEqual({ id: "s1", endedAt: "2026-01-01T00:00:00.000Z", status: "closed" });
      expect(result && "body" in result).toBe(false);
    });

    it("returns null for an unknown session", async () => {
      const reader = new SqliteOutcomeSessionReader(storage.rawDb());
      expect(await reader.getById("team_local", "missing")).toBeNull();
    });
  });

  describe("SqliteOutcomeSignalReader", () => {
    it("lists signals correlated to a session", async () => {
      await storage.signals.insert("team_local", makeSignal({ id: "sig-1", sessionId: "s1", outcome: "fail" }));
      await storage.signals.insert("team_local", makeSignal({ id: "sig-2", sessionId: "s2", outcome: "pass" }));
      const reader = new SqliteOutcomeSignalReader(storage.rawDb());
      const result = await reader.listForSession("team_local", "s1");
      expect(result).toEqual([{ id: "sig-1", outcome: "fail" }]);
    });

    it("returns an empty array for a session with no signals", async () => {
      const reader = new SqliteOutcomeSignalReader(storage.rawDb());
      expect(await reader.listForSession("team_local", "s1")).toEqual([]);
    });
  });

  describe("SqliteOutcomeEdgeReader", () => {
    it("returns edges pointing at the session, filtered to rollup-relevant kinds", async () => {
      storage.sessions.insertSessionForTest(makeSession({ id: "s1" }));
      storage.sessions.insertSessionForTest(makeSession({ id: "s2" }));
      storage.sessions.insertSessionForTest(makeSession({ id: "s3" }));
      storage.sessions.insertEdgeForTest("s2", "s1", "continues");
      storage.sessions.insertEdgeForTest("s3", "s2", "continues"); // touches s2, not s1
      const reader = new SqliteOutcomeEdgeReader(storage.rawDb());
      const result = await reader.listForSession("team_local", "s1");
      expect(result).toEqual([{ fromSession: "s2", toSession: "s1", kind: "continues" }]);
    });
  });

  describe("SqliteOutcomeCitationReader", () => {
    it("lists citations for a session from the citation log, ignoring other sessions' rows", async () => {
      const lines = [
        { ts: new Date().toISOString(), conversation_id: "conv-1", cited_id: "s1" },
        { ts: new Date().toISOString(), conversation_id: "conv-2", cited_id: "s2" },
      ];
      writeFileSync(citationLogPath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
      const reader = new SqliteOutcomeCitationReader(citationLogPath);
      const result = await reader.listForSession("s1");
      expect(result).toEqual([{ conversationId: "conv-1" }]);
    });

    it("returns an empty array when the log file does not exist", async () => {
      const reader = new SqliteOutcomeCitationReader(join(tmp, "nonexistent.jsonl"));
      expect(await reader.listForSession("s1")).toEqual([]);
    });
  });

  describe("buildSqliteOutcomeDeps", () => {
    it("wires all four readers plus re-derivation pairs into a working OutcomeDeps", async () => {
      storage.sessions.insertSessionForTest(
        makeSession({ id: "s1", endedAt: "2026-01-01T00:00:00.000Z", status: "superseded" }),
      );
      const deps = await buildSqliteOutcomeDeps(storage.rawDb(), {
        citationLogPath,
        reDerivationPairsPath: join(tmp, "nonexistent-pairs.json"),
      });
      const session = await deps.sessions.getById("team_local", "s1");
      expect(session?.status).toBe("superseded");
      expect(deps.reDerivationPairs).toEqual([]);
    });

    it("reads re-derivation pairs from the corpus-monitor's cache file", async () => {
      const pairsPath = join(tmp, "re-derivation-pairs.json");
      const pairs = [{ a: "s1", b: "s2", sharedEntities: ["pgvector"], jaccard: 0.8 }];
      writeFileSync(pairsPath, JSON.stringify(pairs));
      const deps = await buildSqliteOutcomeDeps(storage.rawDb(), { citationLogPath, reDerivationPairsPath: pairsPath });
      expect(deps.reDerivationPairs).toEqual(pairs);
    });

    it("falls back to [] when the pairs cache file is corrupt", async () => {
      const pairsPath = join(tmp, "re-derivation-pairs.json");
      writeFileSync(pairsPath, "{not valid json");
      const deps = await buildSqliteOutcomeDeps(storage.rawDb(), { citationLogPath, reDerivationPairsPath: pairsPath });
      expect(deps.reDerivationPairs).toEqual([]);
    });

    it("falls back to [] when the pairs cache file contains a non-array shape", async () => {
      const pairsPath = join(tmp, "re-derivation-pairs.json");
      writeFileSync(pairsPath, JSON.stringify({ oops: "not an array" }));
      const deps = await buildSqliteOutcomeDeps(storage.rawDb(), { citationLogPath, reDerivationPairsPath: pairsPath });
      expect(deps.reDerivationPairs).toEqual([]);
    });

    it("discards a pairs cache older than 72h (monitor presumed dead)", async () => {
      const pairsPath = join(tmp, "re-derivation-pairs.json");
      const pairs = [{ a: "s1", b: "s2", sharedEntities: ["pgvector"], jaccard: 0.8 }];
      writeFileSync(pairsPath, JSON.stringify(pairs));
      const staleSec = (Date.now() - 73 * 60 * 60 * 1000) / 1000;
      utimesSync(pairsPath, staleSec, staleSec);
      const deps = await buildSqliteOutcomeDeps(storage.rawDb(), { citationLogPath, reDerivationPairsPath: pairsPath });
      expect(deps.reDerivationPairs).toEqual([]);
    });

    it("keeps a pairs cache younger than 72h", async () => {
      const pairsPath = join(tmp, "re-derivation-pairs.json");
      const pairs = [{ a: "s1", b: "s2", sharedEntities: ["pgvector"], jaccard: 0.8 }];
      writeFileSync(pairsPath, JSON.stringify(pairs));
      const freshSec = (Date.now() - 71 * 60 * 60 * 1000) / 1000;
      utimesSync(pairsPath, freshSec, freshSec);
      const deps = await buildSqliteOutcomeDeps(storage.rawDb(), { citationLogPath, reDerivationPairsPath: pairsPath });
      expect(deps.reDerivationPairs).toEqual(pairs);
    });
  });

  describe("loadOutcomeCoverageInput", () => {
    it("batches sessions/signals/edges/citations in one pass across the window", async () => {
      storage.sessions.insertSessionForTest(
        makeSession({ id: "s1", endedAt: "2026-01-19T00:00:00.000Z", status: "closed" }),
      );
      storage.sessions.insertSessionForTest(
        makeSession({ id: "s2", endedAt: "2026-01-18T00:00:00.000Z", status: "closed" }),
      );
      // Outside the window — must not appear.
      storage.sessions.insertSessionForTest(
        makeSession({ id: "s_old", endedAt: "2025-01-01T00:00:00.000Z", status: "closed" }),
      );
      await storage.signals.insert("team_local", makeSignal({ id: "sig-1", sessionId: "s1", outcome: "pass" }));
      storage.sessions.insertEdgeForTest("s2", "s1", "continues");
      writeFileSync(
        citationLogPath,
        JSON.stringify({ ts: new Date().toISOString(), conversation_id: "conv-1", cited_id: "s2" }) + "\n",
      );

      const pairsPath = join(tmp, "re-derivation-pairs.json");
      const pairs = [{ a: "s1", b: "s2", sharedEntities: ["pgvector"], jaccard: 0.9 }];
      writeFileSync(pairsPath, JSON.stringify(pairs));

      const input = await loadOutcomeCoverageInput(storage.rawDb(), "team_local", {
        sinceIso: "2026-01-01T00:00:00.000Z",
        citationLogPath,
        reDerivationPairsPath: pairsPath,
      });

      expect(input.sessions.map((s) => s.id).sort()).toEqual(["s1", "s2"]);
      expect(input.signalsBySession.get("s1")).toEqual([{ id: "sig-1", outcome: "pass" }]);
      expect(input.edgesBySession.get("s1")).toEqual([{ fromSession: "s2", toSession: "s1", kind: "continues" }]);
      expect(input.citationsBySession.get("s2")).toEqual([{ conversationId: "conv-1" }]);
      expect(input.reDerivationPairs).toEqual(pairs);
    });

    it("returns empty maps and an empty session list outside the window", async () => {
      storage.sessions.insertSessionForTest(
        makeSession({ id: "s_old", endedAt: "2025-01-01T00:00:00.000Z", status: "closed" }),
      );
      const input = await loadOutcomeCoverageInput(storage.rawDb(), "team_local", {
        sinceIso: "2026-01-01T00:00:00.000Z",
        citationLogPath,
        reDerivationPairsPath: join(tmp, "nonexistent-pairs.json"),
      });
      expect(input.sessions).toEqual([]);
      expect(input.signalsBySession.size).toBe(0);
      expect(input.reDerivationPairs).toEqual([]);
    });
  });
});
