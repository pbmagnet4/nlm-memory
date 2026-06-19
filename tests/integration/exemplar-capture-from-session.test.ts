import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  captureExemplarsFromSession,
  composeTaskContext,
} from "../../src/core/exemplars/capture-from-session.js";
import type { CodeExemplarStore } from "../../src/ports/code-exemplar-store.js";
import type { CodeEmbedder } from "../../src/ports/code-embedder.js";
import type { CodeExemplarInput } from "../../src/shared/types.js";
import { drainSessionExemplars } from "../../src/core/exemplars/capture-from-session.js";

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

describe("captureExemplarsFromSession", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "nlm-capsess-"));
    git(repo, "init", "-q");
    git(repo, "config", "user.email", "t@t.test");
    git(repo, "config", "user.name", "t");
    writeFileSync(join(repo, "throttle.ts"), "export function throttle(fn: () => void, ms: number) {\n  let last = 0;\n  return () => { const now = Date.now(); if (now - last > ms) { last = now; fn(); } };\n}\n");
    git(repo, "add", "throttle.ts");
    git(repo, "commit", "-q", "-m", "add throttle helper");
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("captures one exemplar from a session that committed", () => {
    const sha = git(repo, "rev-parse", "--short", "HEAD");
    const text = `assistant ran git commit\n[main ${sha}] add throttle helper\n 1 file changed`;
    const out = captureExemplarsFromSession({
      sessionId: "sess1",
      projectDir: repo,
      text,
      startedAt: "2026-06-19T12:00:00.000Z",
      summary: "Added a throttle utility",
      decisions: ["chose throttle over debounce for the scroll handler"],
      installScope: "install-test",
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.code).toContain("now - last > ms");
    expect(out[0]!.outcome).toBe("pass");
    expect(out[0]!.sessionId).toBe("sess1");
    expect(out[0]!.taskContext).toContain("throttle");
  });

  it("returns nothing when the session shows no commit", () => {
    const out = captureExemplarsFromSession({
      sessionId: "sess2", projectDir: repo, text: "no commit here",
      startedAt: "2026-06-19T12:00:00.000Z", summary: "chat", decisions: [], installScope: "install-test",
    });
    expect(out).toEqual([]);
  });

  it("returns nothing when projectDir is not a git repo", () => {
    const notRepo = mkdtempSync(join(tmpdir(), "nlm-norepo-"));
    try {
      const out = captureExemplarsFromSession({
        sessionId: "sess3", projectDir: notRepo, text: "[main 1a2b3c4] x",
        startedAt: "2026-06-19T12:00:00.000Z", summary: "s", decisions: [], installScope: "install-test",
      });
      expect(out).toEqual([]);
    } finally {
      rmSync(notRepo, { recursive: true, force: true });
    }
  });

  it("composeTaskContext prefers the decision when present", () => {
    expect(composeTaskContext("Added a throttle utility", ["chose throttle over debounce"]))
      .toBe("Added a throttle utility - chose throttle over debounce");
    expect(composeTaskContext("Just a summary", [])).toBe("Just a summary");
  });
});

function fakeStore(): CodeExemplarStore & { inserted: CodeExemplarInput[]; embedded: string[] } {
  const inserted: CodeExemplarInput[] = [];
  const embedded: string[] = [];
  return {
    inserted, embedded,
    async insert(i) { inserted.push(i); return { id: `ex_${inserted.length}`, skipped: false }; },
    async insertMany(is) { for (const i of is) inserted.push(i); return is.length; },
    async upsertEmbedding(id) { embedded.push(id); },
    async searchByVector() { return []; },
    async getById() { return null; },
    async applyBucketCap() { return 0; },
    async pruneReverted() { return 0; },
    async pruneOlderThan() { return 0; },
    async setVerdict() { return { status: "not_found" as const }; },
  };
}
const fakeEmbedder: CodeEmbedder = { async embed() { return { vector: new Float32Array(768), dim: 768 }; } };

describe("drainSessionExemplars", () => {
  let repo: string;
  const prev = process.env["NLM_CODE_EXEMPLARS_ENABLED"];
  beforeEach(() => {
    delete process.env["NLM_CODE_EXEMPLARS_ENABLED"];
    repo = mkdtempSync(join(tmpdir(), "nlm-drain-"));
    git(repo, "init", "-q");
    git(repo, "config", "user.email", "t@t.test");
    git(repo, "config", "user.name", "t");
    writeFileSync(join(repo, "x.ts"), "export const x = () => {\n  const v = 1 + 1;\n  return v;\n};\n");
    git(repo, "add", "x.ts");
    git(repo, "commit", "-q", "-m", "add x");
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    if (prev === undefined) delete process.env["NLM_CODE_EXEMPLARS_ENABLED"];
    else process.env["NLM_CODE_EXEMPLARS_ENABLED"] = prev;
  });

  function ctx() {
    const sha = git(repo, "rev-parse", "--short", "HEAD");
    return {
      sessionId: "s", projectDir: repo, text: `[main ${sha}] add x`,
      startedAt: "2026-06-19T12:00:00.000Z", summary: "add x", decisions: [], installScope: "install-test",
    };
  }

  it("is a no-op when the flag is off", async () => {
    const store = fakeStore();
    const n = await drainSessionExemplars(ctx(), { exemplarStore: store, codeEmbedder: fakeEmbedder });
    expect(n).toBe(0);
    expect(store.inserted).toHaveLength(0);
  });

  it("inserts + embeds when the flag is on", async () => {
    process.env["NLM_CODE_EXEMPLARS_ENABLED"] = "1";
    const store = fakeStore();
    const n = await drainSessionExemplars(ctx(), { exemplarStore: store, codeEmbedder: fakeEmbedder });
    expect(n).toBe(1);
    expect(store.inserted).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 10)); // let the fire-and-forget embed resolve
    expect(store.embedded).toEqual(["ex_1"]);
  });

  it("never throws when the store fails", async () => {
    process.env["NLM_CODE_EXEMPLARS_ENABLED"] = "1";
    const broken: CodeExemplarStore = { ...fakeStore(), async insert() { throw new Error("db down"); } };
    await expect(drainSessionExemplars(ctx(), { exemplarStore: broken })).resolves.toBe(0);
  });
});
