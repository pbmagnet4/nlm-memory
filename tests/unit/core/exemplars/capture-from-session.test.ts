import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureExemplarsFromSession } from "../../../../src/core/exemplars/capture-from-session.js";

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

describe("captureExemplarsFromSession model passthrough", () => {
  let repo: string;
  let sha: string;
  let transcriptText: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "nlm-cfs-"));
    git(repo, "init", "-q");
    git(repo, "config", "user.email", "t@t.test");
    git(repo, "config", "user.name", "t");
    writeFileSync(
      join(repo, "util.ts"),
      "export function double(n: number): number {\n  const result = n * 2;\n  return result;\n}\n",
    );
    git(repo, "add", "util.ts");
    git(repo, "commit", "-q", "-m", "add double util");
    sha = git(repo, "rev-parse", "HEAD");
    transcriptText = `[assistant] I committed the changes.\n[main ${sha}] add double util`;
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("passes chunk model through to the extracted exemplar", () => {
    const exemplars = captureExemplarsFromSession({
      sessionId: "sess-001",
      projectDir: repo,
      text: transcriptText,
      startedAt: "2026-06-01T10:00:00.000Z",
      summary: "implement double util",
      decisions: [],
      installScope: "user",
      scope: null,
      model: "m-test",
    });
    expect(exemplars.length).toBeGreaterThan(0);
    expect(exemplars[0]!.model).toBe("m-test");
  });

  it("exemplar has model=unknown when no model provided", () => {
    const exemplars = captureExemplarsFromSession({
      sessionId: "sess-002",
      projectDir: repo,
      text: transcriptText,
      startedAt: "2026-06-01T10:00:00.000Z",
      summary: "implement double util",
      decisions: [],
      installScope: "user",
      scope: null,
    });
    expect(exemplars.length).toBeGreaterThan(0);
    expect(exemplars[0]!.model).toBe("unknown");
  });
});
