import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractFromGitSha } from "../../../../src/core/exemplars/extract-exemplar.js";

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

describe("extractFromGitSha (params object)", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "nlm-gitex-"));
    git(repo, "init", "-q");
    git(repo, "config", "user.email", "t@t.test");
    git(repo, "config", "user.name", "t");
    writeFileSync(join(repo, "add.ts"), "export function add(a: number, b: number) {\n  const total = a + b;\n  return total;\n}\n");
    git(repo, "add", "add.ts");
    git(repo, "commit", "-q", "-m", "add adder");
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("extracts the committed hunk for a sha", () => {
    const sha = git(repo, "rev-parse", "HEAD");
    const ex = extractFromGitSha({ repo, sha, installScope: "s", outcome: "pass" });
    expect(ex).not.toBeNull();
    expect(ex!.code).toContain("const total = a + b");
    expect(ex!.lang).toBe("ts");
    expect(ex!.outcome).toBe("pass");
    expect(ex!.gitSha).toBe(sha);
    expect(ex!.model).toBe("unknown");
  });

  it("returns null without writing git's error to stderr for an unknown sha", () => {
    const mod = join(process.cwd(), "src/core/exemplars/extract-exemplar.ts");
    const script = `const { extractFromGitSha } = await import(${JSON.stringify(mod)});
      const ex = extractFromGitSha({ repo: ${JSON.stringify(repo)}, sha: "1048576", installScope: "s", outcome: "pass" });
      process.stdout.write(String(ex));`;
    const r = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { encoding: "utf8" });
    expect(r.stdout).toBe("null");
    expect(r.stderr).toBe("");
  });

  it("uses a provided taskContext override", () => {
    const sha = git(repo, "rev-parse", "HEAD");
    const ex = extractFromGitSha({ repo, sha, installScope: "s", outcome: "pass", taskContext: "implement the adder" });
    expect(ex!.taskContext).toBe("implement the adder");
  });

  it("returns null for an unknown sha", () => {
    const ex = extractFromGitSha({ repo, sha: "deadbeef", installScope: "s", outcome: "pass" });
    expect(ex).toBeNull();
  });
});
