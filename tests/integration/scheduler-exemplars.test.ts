/**
 * Integration test: ScanScheduler captures code exemplars from committed sessions.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import { ClaudeCodeAdapter } from "../../src/core/adapters/claude-code.js";
import { ScanScheduler } from "../../src/core/scheduler/scheduler.js";
import type { ClassifyResult, EmbedResult, LLMClient } from "../../src/ports/llm-client.js";
import type { CodeEmbedder } from "../../src/ports/code-embedder.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

class StubClassifier implements LLMClient {
  async embed(): Promise<EmbedResult> { throw new Error("nu"); }
  async rewriteForRecall(): Promise<never> { throw new Error("nu"); }
  nameWorkstream(): Promise<string | null> { throw new Error("stub"); }
  async classify(): Promise<ClassifyResult> {
    return { label: "L", summary: "Added throttle", entities: ["throttle"], decisions: ["chose throttle"], open: [], confidence: 0.9, facts: [] };
  }
}
class StubEmbedder implements LLMClient {
  async embed(): Promise<EmbedResult> { const v = new Float32Array(768); v[0] = 1; return { vector: v, model: "stub" }; }
  async rewriteForRecall(): Promise<never> { throw new Error("nu"); }
  nameWorkstream(): Promise<string | null> { throw new Error("stub"); }
  async classify(): Promise<never> { throw new Error("nu"); }
}
const stubCodeEmbedder: CodeEmbedder = { async embed() { const v = new Float32Array(768); v[1] = 1; return { vector: v, dim: 768 }; } };

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

describe("scheduler captures exemplars from committed sessions", () => {
  let storage: SqliteStorage; let dbDir: string; let repo: string; let projects: string;
  const prev = process.env["NLM_CODE_EXEMPLARS_ENABLED"];
  beforeEach(async () => {
    process.env["NLM_CODE_EXEMPLARS_ENABLED"] = "1";
    dbDir = mkdtempSync(join(tmpdir(), "nlm-sched-ex-"));
    storage = SqliteStorage.create({ dbPath: join(dbDir, "canonical.sqlite"), migrationsDir: MIGRATIONS_DIR });
    await storage.init();

    // a real git repo that is the session's cwd
    repo = mkdtempSync(join(tmpdir(), "nlm-sched-repo-"));
    git(repo, "init", "-q"); git(repo, "config", "user.email", "t@t.test"); git(repo, "config", "user.name", "t");
    writeFileSync(join(repo, "t.ts"), "export const t = () => {\n  const v = 2 + 2;\n  return v;\n};\n");
    git(repo, "add", "t.ts"); git(repo, "commit", "-q", "-m", "add t");
    const sha = git(repo, "rev-parse", "--short", "HEAD");

    // a claude-code transcript whose cwd = the repo and whose text shows the commit
    projects = mkdtempSync(join(tmpdir(), "nlm-cc-"));
    const projDir = join(projects, "proj"); mkdirSync(projDir, { recursive: true });
    const jsonl =
      JSON.stringify({ type: "user", cwd: repo, timestamp: "2026-06-19T12:00:00.000Z", message: { role: "user", content: "add a throttle" } }) + "\n" +
      JSON.stringify({ type: "assistant", cwd: repo, timestamp: "2026-06-19T12:01:00.000Z", message: { role: "assistant", content: `committed: [main ${sha}] add t` } }) + "\n";
    const file = join(projDir, "session.jsonl");
    writeFileSync(file, jsonl);
    const old = (Date.now() - 60 * 60 * 1000) / 1000; // older than idleMinutes
    utimesSync(file, old, old);
  });
  afterEach(async () => {
    await storage.close();
    for (const d of [dbDir, repo, projects]) rmSync(d, { recursive: true, force: true });
    if (prev === undefined) delete process.env["NLM_CODE_EXEMPLARS_ENABLED"];
    else process.env["NLM_CODE_EXEMPLARS_ENABLED"] = prev;
  });

  it("lands an exemplar after a tick", async () => {
    const adapter = new ClaudeCodeAdapter({ projectsPath: projects, idleMinutes: 1 });
    const scheduler = new ScanScheduler({
      store: storage.sessions,
      adapters: [adapter],
      classifier: new StubClassifier(),
      embedder: new StubEmbedder(),
      installScope: "install-test",
      exemplarStore: storage.exemplars,
      codeEmbedder: stubCodeEmbedder,
      idleMinutes: 1,
      logger: () => {},
    });
    await scheduler.tick();

    // Assert directly on the table — deterministic, independent of the
    // fire-and-forget embed. A second readonly connection is safe.
    const db = new Database(join(dbDir, "canonical.sqlite"), { readonly: true });
    const row = db.prepare("SELECT COUNT(*) AS n, MIN(code) AS code FROM code_exemplars").get() as { n: number; code: string | null };
    db.close();
    expect(row.n).toBe(1);
    expect(row.code).toContain("2 + 2");
  });
});
