/**
 * T1772 Part 1+2: the scheduled online backup job.
 * IO tests run against a real better-sqlite3 handle in a temp dir; the
 * free-space probe and (except in the last block) the check worker are
 * injected so the suite stays fast and deterministic.
 */
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  backupIntervalMs,
  backupKeep,
  backupStampUTC,
  INTEGRITY_STATE_FILENAME,
  runScheduledBackup,
  scheduledBackupEnabled,
  scheduledBackupsToPrune,
} from "../../../../src/core/storage/scheduled-backup.js";
import { runQuickCheckOnFile } from "../../../../src/core/storage/backup-check.js";

describe("env parsing", () => {
  it("defaults: 24h interval, keep 7, enabled", () => {
    expect(backupIntervalMs({})).toBe(24 * 3_600_000);
    expect(backupKeep({})).toBe(7);
    expect(scheduledBackupEnabled({})).toBe(true);
  });
  it("honours NLM_BACKUP_INTERVAL_HOURS / NLM_BACKUP_KEEP / NLM_BACKUP=off", () => {
    expect(backupIntervalMs({ NLM_BACKUP_INTERVAL_HOURS: "6" })).toBe(6 * 3_600_000);
    expect(backupKeep({ NLM_BACKUP_KEEP: "3" })).toBe(3);
    expect(scheduledBackupEnabled({ NLM_BACKUP: "off" })).toBe(false);
  });
  it("falls back on garbage or non-positive values", () => {
    expect(backupIntervalMs({ NLM_BACKUP_INTERVAL_HOURS: "abc" })).toBe(24 * 3_600_000);
    expect(backupIntervalMs({ NLM_BACKUP_INTERVAL_HOURS: "0" })).toBe(24 * 3_600_000);
    expect(backupKeep({ NLM_BACKUP_KEEP: "-2" })).toBe(7);
    expect(backupKeep({ NLM_BACKUP_KEEP: "0" })).toBe(7);
  });
});

describe("backupStampUTC", () => {
  it("formats yyyyMMddHHMM in UTC, zero-padded", () => {
    expect(backupStampUTC(new Date("2026-11-11T05:07:33Z"))).toBe("202611110507");
    expect(backupStampUTC(new Date("2026-01-02T00:00:00Z"))).toBe("202601020000");
  });
});

describe("scheduledBackupsToPrune", () => {
  const files = [
    "canonical-202611111200.sqlite",
    "canonical-202611101200.sqlite",
    "canonical-202611091200.sqlite",
    "canonical-2026-06-16.sqlite", // legacy date-stamped generation: never touched
    "notes.txt",
  ];
  it("keeps the newest N scheduled files, prunes the rest", () => {
    expect(scheduledBackupsToPrune(files, 2)).toEqual(["canonical-202611091200.sqlite"]);
  });
  it("keeps everything when keep >= count, and ignores non-scheduled names", () => {
    expect(scheduledBackupsToPrune(files, 7)).toEqual([]);
  });
});

describe("runScheduledBackup (real sqlite)", () => {
  let tmp: string;
  let dbPath: string;
  let db: Database.Database;
  let logs: string[];
  let clock: { current: Date; ticks: number };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-sched-backup-"));
    dbPath = join(tmp, "canonical.sqlite");
    db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, body TEXT)");
    const ins = db.prepare("INSERT INTO sessions (id, body) VALUES (?, ?)");
    for (let i = 0; i < 50; i += 1) ins.run(`s${i}`, `row ${i} ${"x".repeat(200)}`);
    db.pragma("wal_checkpoint(TRUNCATE)");
    logs = [];
    clock = { current: new Date("2026-11-11T05:30:00Z"), ticks: 0 };
  });
  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  const deps = (over: Record<string, unknown> = {}) => ({
    db,
    dbPath,
    env: {} as NodeJS.ProcessEnv,
    logger: (m: string) => logs.push(m),
    now: () => clock.current,
    elapsed: () => (clock.ticks += 137),
    freeBytes: async () => 1_000 * 1024 ** 3,
    quickCheck: async () => ({ ok: true as const }),
    ...over,
  });

  it("writes canonical-<UTC stamp>.sqlite, logs size+ms, records ok", async () => {
    const res = await runScheduledBackup(deps());
    expect(res.status).toBe("ok");
    const file = join(tmp, "backups", "canonical-202611110530.sqlite");
    expect(res.file).toBe(file);
    const names = readdirSync(join(tmp, "backups"));
    expect(names).toEqual(["canonical-202611110530.sqlite"]);
    expect(res.bytes).toBe(statSync(file).size);
    expect(res.bytes).toBeGreaterThan(0);
    // One summary line carrying size and duration.
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("canonical-202611110530.sqlite");
    expect(logs[0]).toMatch(/MiB in \d+ms check=ok pruned=0/);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const state = JSON.parse(readFileSync(join(tmp, INTEGRITY_STATE_FILENAME), "utf8"));
    expect(state).toMatchObject({ backup: "canonical-202611110530.sqlite", ok: true });
  });

  it("the snapshot is a consistent, restorable copy of the live DB", async () => {
    const res = await runScheduledBackup(deps());
    const copy = new Database(res.file!, { readonly: true, fileMustExist: true });
    expect(copy.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 50 });
    copy.close();
  });

  it("skips while the newest scheduled snapshot is inside the interval", async () => {
    await runScheduledBackup(deps());
    clock.current = new Date("2026-11-11T06:30:00Z"); // +1h < 24h
    const res = await runScheduledBackup(deps());
    expect(res.status).toBe("skipped-fresh");
    expect(readdirSync(join(tmp, "backups"))).toHaveLength(1);
    expect(logs.some((l) => l.includes("skipped"))).toBe(true);
  });

  it("runs again past the interval (NLM_BACKUP_INTERVAL_HOURS)", async () => {
    await runScheduledBackup(deps());
    clock.current = new Date("2026-11-11T06:30:00Z");
    const res = await runScheduledBackup(deps({ env: { NLM_BACKUP_INTERVAL_HOURS: "0.5" } }));
    expect(res.status).toBe("ok");
    expect(readdirSync(join(tmp, "backups"))).toHaveLength(2);
  });

  it("does not count legacy date-stamped snapshots for freshness", async () => {
    mkdirSync(join(tmp, "backups"), { recursive: true });
    writeFileSync(join(tmp, "backups", "canonical-2026-11-11.sqlite"), "legacy");
    const res = await runScheduledBackup(deps());
    expect(res.status).toBe("ok");
  });

  it("skips with WARN when free space is below 3x the DB size", async () => {
    const dbBytes = statSync(dbPath).size;
    const res = await runScheduledBackup(deps({ freeBytes: async () => dbBytes * 2 }));
    expect(res.status).toBe("skipped-low-disk");
    expect(readdirSync(join(tmp, "backups"))).toHaveLength(0);
    expect(logs.some((l) => l.startsWith("[backup] WARN") && l.includes("3x db size"))).toBe(true);
  });

  it("keeps the newest N (NLM_BACKUP_KEEP) and never prunes legacy names", async () => {
    const dir = join(tmp, "backups");
    mkdirSync(dir, { recursive: true });
    for (const stamp of ["202601010000", "202601020000", "202601030000"]) {
      writeFileSync(join(dir, `canonical-${stamp}.sqlite`), "old");
    }
    writeFileSync(join(dir, "canonical-2026-01-01.sqlite"), "legacy");
    const res = await runScheduledBackup(deps({ env: { NLM_BACKUP_KEEP: "2" } }));
    expect(res.status).toBe("ok");
    const names = readdirSync(dir).sort();
    expect(names).toContain("canonical-202611110530.sqlite"); // newest
    expect(names).toContain("canonical-202601030000.sqlite"); // second newest
    expect(names).not.toContain("canonical-202601010000.sqlite");
    expect(names).not.toContain("canonical-202601020000.sqlite");
    expect(names).toContain("canonical-2026-01-01.sqlite"); // legacy generation untouched
    expect(logs[0]).toContain("pruned=2");
  });

  it("keeps the snapshot and logs ERROR when quick_check fails on it", async () => {
    const res = await runScheduledBackup(deps({
      quickCheck: async () => ({ ok: false, error: "btree msg for page 3: corrupt" }),
    }));
    expect(res.status).toBe("ok"); // the backup itself succeeded; visibility is the point
    expect(res.integrityOk).toBe(false);
    expect(logs.some((l) => l.startsWith("[backup] ERROR quick_check FAILED") && l.includes("corrupt"))).toBe(true);
    const state = JSON.parse(readFileSync(join(tmp, INTEGRITY_STATE_FILENAME), "utf8"));
    expect(state).toMatchObject({ backup: "canonical-202611110530.sqlite", ok: false, error: "btree msg for page 3: corrupt" });
  });

  it("treats a throwing check as a failed check, not a crashed run", async () => {
    const res = await runScheduledBackup(deps({
      quickCheck: async () => { throw new Error("worker exploded"); },
    }));
    expect(res.status).toBe("ok");
    expect(res.integrityOk).toBe(false);
    expect(logs.some((l) => l.includes("worker exploded"))).toBe(true);
  });
});

describe("runQuickCheckOnFile (real worker thread)", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-backup-check-"));
  });
  it("passes ok on a healthy backup file", async () => {
    const src = join(tmp, "good.sqlite");
    const db = new Database(src);
    db.exec("CREATE TABLE t (a TEXT); INSERT INTO t VALUES ('x')");
    await db.backup(join(tmp, "snap.sqlite"));
    db.close();
    const res = await runQuickCheckOnFile(join(tmp, "snap.sqlite"));
    expect(res).toEqual({ ok: true });
  });
  it("fails (does not throw) on a file that is not a database", async () => {
    const bad = join(tmp, "bad.sqlite");
    writeFileSync(bad, "this is not sqlite at all, not even a little");
    const res = await runQuickCheckOnFile(bad);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not a database|file is not a database/i);
  });
  it("detects page corruption in a snapshot", async () => {
    const src = join(tmp, "corrupt-src.sqlite");
    const db = new Database(src);
    db.exec("CREATE TABLE t (a TEXT)");
    const ins = db.prepare("INSERT INTO t (a) VALUES (?)");
    for (let i = 0; i < 500; i += 1) ins.run("y".repeat(400));
    db.close();
    const snap = join(tmp, "corrupt-snap.sqlite");
    const ro = new Database(src);
    await ro.backup(snap);
    ro.close();
    // Garble a mid-file page (header is page 1; leave it intact so a
    // quick_check runs rather than the open failing).
    const buf = readFileSync(snap);
    const off = Math.floor(buf.length / 2);
    buf.fill(0xAB, off, off + 4096);
    writeFileSync(snap, buf);
    const res = await runQuickCheckOnFile(snap);
    expect(res.ok).toBe(false);
  });
});
