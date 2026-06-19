import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  captureExemplarsFromSession,
  composeTaskContext,
} from "../../src/core/exemplars/capture-from-session.js";

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
      .toBe("Added a throttle utility — chose throttle over debounce");
    expect(composeTaskContext("Just a summary", [])).toBe("Just a summary");
  });
});
