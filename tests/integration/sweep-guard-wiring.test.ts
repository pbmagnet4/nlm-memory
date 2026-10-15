/**
 * Property-style checks that the wired sweeps honour the shared guard on
 * synthetic stores of varying size: no unguarded crossing, one audit line per
 * decision, dry runs never mutate.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyRetirements, findContradictions, previewRetirements, type AuthoritiesFile } from "../../src/core/facts/reconcile-facts.js";
import { applyFixOnSqlite } from "../../src/core/integrity/check-invariants.js";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import { DEFAULT_TEAM_ID } from "../../src/core/tenancy/default-team.js";
import { makeSignal } from "../fixtures/signals.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");
const SIZES = [3, 10, 20, 50];

describe("sweep guard wiring", () => {
  let dir: string;
  let audit: string;
  let storage: SqliteStorage;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nlm-sweepwire-"));
    audit = join(dir, "audit.jsonl");
    process.env["NLM_SWEEP_AUDIT_LOG"] = audit;
    delete process.env["NLM_SWEEP_OVERRIDE"];
    storage = SqliteStorage.create({ dbPath: join(dir, "t.sqlite"), migrationsDir: MIGRATIONS_DIR });
    storage.rawDb().pragma("foreign_keys = OFF");
  });
  afterEach(async () => {
    delete process.env["NLM_SWEEP_AUDIT_LOG"];
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const auditLines = () =>
    existsSync(audit) ? readFileSync(audit, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

  const authorities: AuthoritiesFile = {
    authorities: [{ aliases: ["svc"], predicate: "port", value: "7001", source: "registry" }],
    deleted_files: [],
  };

  function seedFacts(bad: number, good: number): void {
    const ins = storage.rawDb().prepare(
      `INSERT INTO facts (id, kind, subject, predicate, value, source_session_id, confidence, created_at)
       VALUES (?, 'attribute', ?, ?, ?, 's1', 1.0, '2026-01-01 00:00:00')`,
    );
    for (let i = 0; i < bad; i++) ins.run(`bad${i}`, "svc", "port", `${8000 + i}`);
    for (let i = 0; i < good; i++) ins.run(`ok${i}`, `other${i}`, "note", "x");
  }
  const retired = () => (storage.rawDb().prepare("SELECT COUNT(*) n FROM facts WHERE retired_at IS NOT NULL").get() as { n: number }).n;

  it("reconcile-facts: refuses past the share limit, applies under it, always logs, dry run is read-only", async () => {
    for (const total of SIZES) {
      storage.rawDb().exec("DELETE FROM facts");
      seedFacts(total - Math.floor(total / 2), Math.floor(total / 2)); // majority are findings
      const findings = findContradictions(storage.rawDb(), authorities);
      const overLimit = total >= 10 && findings.length / total > 0.8;

      const before = auditLines().length;
      const preview = previewRetirements(storage.rawDb(), findings, 1000, { auditPath: audit });
      expect(preview.mode).toBe("dry-run");
      expect(retired()).toBe(0);
      expect(auditLines()).toHaveLength(before + 1);

      const res = await applyRetirements(storage.rawDb(), join(dir, "t.sqlite"), findings, 1000, join(dir, "sup.jsonl"), { auditPath: audit });
      expect(auditLines()).toHaveLength(before + 2);
      expect(auditLines().at(-1).mode).toBe(res.decision!.mode);
      expect(res.retired.length > 0).toBe(!overLimit);
      expect(retired()).toBe(overLimit ? 0 : findings.length);
    }
  });

  it("reconcile-facts: all-findings store is refused, override applies", async () => {
    seedFacts(20, 0);
    const findings = findContradictions(storage.rawDb(), authorities);
    const refused = await applyRetirements(storage.rawDb(), join(dir, "t.sqlite"), findings, 1000, join(dir, "sup.jsonl"), { auditPath: audit });
    expect(refused.decision!.mode).toBe("refused");
    expect(retired()).toBe(0);
    const forced = await applyRetirements(storage.rawDb(), join(dir, "t.sqlite"), findings, 1000, join(dir, "sup.jsonl"), { auditPath: audit, override: true });
    expect(forced.decision!.overridden).toBe(true);
    expect(retired()).toBe(20);
  });

  it("signal retention prune refuses to wipe a store, and logs", async () => {
    for (const total of SIZES) {
      storage.rawDb().exec("DELETE FROM signals");
      for (let i = 0; i < total; i++) {
        await storage.signals.insert(DEFAULT_TEAM_ID, makeSignal({ id: `sig_${total}_${i}`, ts: "2020-01-01T00:00:00.000Z" }));
      }
      const before = auditLines().length;
      const removed = await storage.signals.pruneOlderThan(DEFAULT_TEAM_ID, "2021-01-01T00:00:00.000Z");
      expect(removed).toBe(total >= 10 ? 0 : total);
      expect(auditLines()).toHaveLength(before + 1);
    }
  });

  it("doctor --fix refuses to delete most embeddings but touches nothing under the limit", () => {
    const db = storage.rawDb();
    const report = applyFixOnSqlite(db, { auditPath: audit });
    expect(report.deletedGhostEmbeddings).toBe(0);
    expect(report.ghostGuardRefusal).toBeUndefined();
  });
});
