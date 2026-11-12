/**
 * T1772 Part 4: the restore drill against real snapshots. The fixture is a
 * migrated canonical DB (sessions + sessions_fts + facts all present), so
 * the three queries exercise the same schema a real backup carries.
 */
import Database from "better-sqlite3";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SqliteStorage } from "../../../../src/core/storage/sqlite-storage.js";
import { pickNewestBackup, runRestoreDrill } from "../../../../src/core/storage/restore-drill.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../../../migrations");

let tmp: string;
let backupFile: string;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "nlm-restore-drill-"));
  const dbPath = join(tmp, "canonical.sqlite");
  const storage = SqliteStorage.create({ dbPath, migrationsDir: MIGRATIONS_DIR });
  await storage.init();
  await storage.close();
  backupFile = join(tmp, "canonical-snapshot.sqlite");
  copyFileSync(dbPath, backupFile);
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("runRestoreDrill", () => {
  it("passes a healthy snapshot and cleans up its temp dir", () => {
    const drillRoot = mkdtempSync(join(tmp, "drill-root-"));
    const report = runRestoreDrill({ backupFile, tmpRoot: drillRoot });
    expect(report.checks.map((c) => [c.name, c.ok])).toEqual([
      ["integrity_check", true],
      ["session count", true],
      [`keyword recall (sessions_fts MATCH "memory")`, true],
      ["fact lookup", true],
    ]);
    expect(report.ok).toBe(true);
    expect(report.checks.find((c) => c.name === "session count")!.detail).toBe("0 sessions");
    // Nothing left behind, and the source snapshot was not opened for write.
    expect(readdirSync(drillRoot)).toEqual([]);
  });

  it("fails (does not throw) on a file that is not a database", () => {
    const bad = join(tmp, "canonical-bad.sqlite");
    writeFileSync(bad, "definitely not sqlite");
    const report = runRestoreDrill({ backupFile: bad, tmpRoot: tmp });
    expect(report.ok).toBe(false);
    const failed = report.checks.filter((c) => !c.ok);
    expect(failed.length).toBeGreaterThan(0);
    // The report shape survives either failure mode (open threw vs check fail).
    expect(report.backup).toBe("canonical-bad.sqlite");
  });

  it("fails when the store's own tables are missing", () => {
    // A valid sqlite file that is not an nlm store: integrity ok, session
    // count must fail.
    const foreign = join(tmp, "canonical-foreign.sqlite");
    const db = new Database(foreign);
    db.exec("CREATE TABLE other (a TEXT)");
    db.close();
    const report = runRestoreDrill({ backupFile: foreign, tmpRoot: tmp });
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name === "integrity_check")!.ok).toBe(true);
    expect(report.checks.find((c) => c.name === "session count")!.ok).toBe(false);
    expect(report.checks.find((c) => c.name === "session count")!.detail).toMatch(/no such table/);
  });

  it("honours a custom keyword", () => {
    const report = runRestoreDrill({ backupFile, tmpRoot: tmp, keyword: "walnut" });
    expect(report.ok).toBe(true);
    expect(report.checks[2]!.name).toContain('MATCH "walnut"');
  });

  it("scopes every representative query to the tenant (default: the local team)", () => {
    // Seeded snapshot: two tenants, one keyword only the *other* team owns. A
    // drill that forgot the tenant filter would see the walnut session and
    // the other team's rows under the default tenant.
    const seeded = join(tmp, "canonical-twotenant.sqlite");
    copyFileSync(backupFile, seeded);
    const db = new Database(seeded);
    const session = db.prepare(
      `INSERT INTO sessions (id, runtime, runtime_session_id, started_at, label, summary, body, status, tenant_id)
       VALUES (?, 'claude', ?, '2026-11-01T00:00:00Z', ?, ?, ?, 'closed', ?)`,
    );
    session.run("s-local-a", "r-a", "local a", "local summary a", "memory of a local session", "team_local");
    session.run("s-local-b", "r-b", "local b", "local summary b", "memory of another local session", "team_local");
    session.run("s-other", "r-o", "other", "other summary", "a walnut recall", "team_other");
    const fact = db.prepare(
      `INSERT INTO facts (id, kind, subject, predicate, value, source_session_id, confidence, tenant_id)
       VALUES (?, 'decision', ?, 'uses', ?, ?, 0.9, ?)`,
    );
    fact.run("f-local", "local subject", "local value", "s-local-a", "team_local");
    fact.run("f-other", "other subject", "other value", "s-other", "team_other");
    db.close();

    const local = runRestoreDrill({ backupFile: seeded, tmpRoot: tmp });
    expect(local.checks.map((c) => c.detail)).toEqual([
      expect.any(String),
      "2 sessions",
      "query served",
      "1 facts",
    ]);
    // The walnut session belongs to team_other, so the default tenant's FTS
    // read must come back empty (still a served query, so the drill passes).
    const localWalnut = runRestoreDrill({ backupFile: seeded, tmpRoot: tmp, keyword: "walnut" });
    expect(localWalnut.ok).toBe(true);
    expect(localWalnut.checks[2]!.detail).toBe("no rows");

    const other = runRestoreDrill({ backupFile: seeded, tmpRoot: tmp, tenantId: "team_other" });
    expect(other.ok).toBe(true);
    expect(other.checks.map((c) => c.detail)).toEqual([
      expect.any(String),
      "1 sessions",
      "no rows",
      "1 facts",
    ]);
    // …and the reverse: team_other sees the walnut row the local tenant cannot.
    const otherWalnut = runRestoreDrill({
      backupFile: seeded,
      tmpRoot: tmp,
      tenantId: "team_other",
      keyword: "walnut",
    });
    expect(otherWalnut.ok).toBe(true);
    expect(otherWalnut.checks[2]!.detail).toBe("query served");
  });
});

describe("pickNewestBackup", () => {
  it("returns null for a missing dir", () => {
    expect(pickNewestBackup(join(tmp, "nope"))).toBeNull();
  });

  it("picks the most recent mtime across both naming generations", () => {
    const dir = join(tmp, "backups");
    const old = Date.parse("2026-11-01T00:00:00Z") / 1000;
    const newer = Date.parse("2026-11-10T00:00:00Z") / 1000;
    mkdirSync(dir, { recursive: true });
    for (const [name, t] of [
      ["canonical-2026-11-02.sqlite", old],
      ["canonical-202611101200.sqlite", newer],
      ["canonical-202611091200.sqlite", old + 10],
      ["notes.txt", Date.now() / 1000],
    ] as const) {
      writeFileSync(join(dir, name), "x");
      utimesSync(join(dir, name), t, t);
    }
    expect(pickNewestBackup(dir)).toBe(join(dir, "canonical-202611101200.sqlite"));
  });
});
