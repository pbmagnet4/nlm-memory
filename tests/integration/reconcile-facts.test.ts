import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyRetirements,
  findContradictions,
  type AuthoritiesFile,
} from "../../src/core/facts/reconcile-facts.js";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

describe("reconcile-facts", () => {
  let dir: string;
  let dbFile: string;
  let logFile: string;
  let storage: SqliteStorage;
  let n = 0;

  const db = () => storage.rawDb();
  function seed(subject: string, predicate: string, value: string, extra: Record<string, unknown> = {}): string {
    const id = `f${++n}`;
    db()
      .prepare(
        `INSERT INTO facts (id, kind, subject, predicate, value, source_session_id, confidence, created_at, superseded_by, retired_at)
         VALUES (@id, @kind, @subject, @predicate, @value, 's1', 1.0, '2026-01-01 00:00:00', @superseded_by, @retired_at)`,
      )
      .run({ id, kind: "attribute", superseded_by: null, retired_at: null, subject, predicate, value, ...extra });
    return id;
  }
  const authorities: AuthoritiesFile = {
    authorities: [{ aliases: ["example-mcp", "example mcp"], predicate: "port", value: "7001", source: "registry" }],
    deleted_files: [{ name: "old-script.sh", deleted_at: "2026-09-01", source: "git log" }],
  };
  const counts = () =>
    db().prepare("SELECT COUNT(*) c, SUM(retired_at IS NOT NULL) r FROM facts").get() as { c: number; r: number };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nlm-reconcile-"));
    dbFile = join(dir, "t.sqlite");
    logFile = join(dir, "log.jsonl");
    storage = SqliteStorage.create({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });
    db().pragma("foreign_keys = OFF");
    n = 0;
  });
  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("dry run reports mismatches and dead refs but writes nothing", () => {
    seed("example-mcp", "port", "7000");
    seed("old-script.sh", "purpose", "does a thing");
    const before = counts();
    const findings = findContradictions(db(), authorities);
    expect(findings.map((f) => f.type).sort()).toEqual(["dead_reference", "value_mismatch"]);
    expect(counts()).toEqual(before);
    expect(counts().r ?? 0).toBe(0);
  });

  it("never reports decisions and ignores superseded or retired facts", () => {
    seed("example-mcp", "port", "7000", { kind: "decision" });
    seed("example-mcp", "port", "7000", { retired_at: "2026-02-01" });
    const other = seed("example-mcp", "port", "9999");
    seed("example-mcp", "port", "7000", { superseded_by: other });
    seed("old-script.sh", "x", "y", { kind: "decision" });
    expect(findContradictions(db(), { ...authorities, authorities: [] })).toHaveLength(0);
    expect(findContradictions(db(), authorities).map((f) => f.factId)).toEqual([other]);
  });

  it.each(["GSC MCP", "gsc-mcp", "gsc_mcp", "  Gsc   Mcp "])("normalizes subject %s", (subject) => {
    seed(subject, "port", "1");
    const file: AuthoritiesFile = {
      authorities: [{ aliases: ["gsc", "gsc-mcp", "gsc mcp"], predicate: "port", value: "2", source: "s" }],
      deleted_files: [],
    };
    expect(findContradictions(db(), file)).toHaveLength(1);
  });

  it("does not flag a port fact that contains the correct port among others", () => {
    seed("example-mcp", "port", "http 7000 and 7001 (both bound)");
    expect(findContradictions(db(), authorities)).toHaveLength(0);
  });

  it("compares host:port for url predicates", () => {
    const file: AuthoritiesFile = {
      authorities: [{ aliases: ["svc"], predicate: "url", value: "http://host.example:8000/mcp", source: "s" }],
      deleted_files: [],
    };
    const ok = seed("svc", "url", "https://HOST.example:8000/other");
    const bad = seed("svc", "url", "http://host.example:8010/mcp");
    expect(findContradictions(db(), file).map((f) => f.factId)).toEqual([bad]);
    expect(ok).not.toBe(bad);
  });

  it("dead_reference matches subjects that start with the deleted name", () => {
    const id = seed("old-script.sh cron entry", "schedule", "daily");
    expect(findContradictions(db(), authorities).map((f) => f.factId)).toEqual([id]);
  });

  it("apply backs up first, retires up to the limit, and logs each fact", async () => {
    seed("example-mcp", "port", "7000");
    seed("example-mcp", "port", "7002");
    seed("old-script.sh", "purpose", "x");
    const keep = seed("example-mcp", "port", "7001");
    const findings = findContradictions(db(), authorities);
    expect(findings).toHaveLength(3);

    const result = await applyRetirements(db(), dbFile, findings, 2, logFile);
    expect(result.retired).toHaveLength(2);
    expect(result.backupPath).not.toBeNull();
    expect(existsSync(result.backupPath as string)).toBe(true);
    expect(readdirSync(dir).some((f) => f.includes(".bak-reconcile-"))).toBe(true);

    const retiredIds = (db().prepare("SELECT id FROM facts WHERE retired_at IS NOT NULL").all() as { id: string }[]).map(
      (r) => r.id,
    );
    expect(retiredIds.sort()).toEqual(result.retired.map((f) => f.factId).sort());
    expect(retiredIds).not.toContain(keep);
    expect((db().prepare("SELECT COUNT(*) c FROM facts").get() as { c: number }).c).toBe(4);

    const log = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(log).toHaveLength(2);
    expect(log.every((l) => l.source === "reconcile" && l.kind === "fact" && /registry|git log/.test(l.reason))).toBe(true);
  });

  it("apply with no findings makes no backup", async () => {
    const result = await applyRetirements(db(), dbFile, [], 100, logFile);
    expect(result.backupPath).toBeNull();
  });
});
