import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractRecallQuery } from "../../../src/core/hook/query-extract.js";
import { buildQuery, readGitContext } from "../../../src/hook/session-start-hook.js";

describe("SessionStart query", () => {
  let repo: string;
  const run = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });

  beforeEach(() => {
    repo = join(mkdtempSync(join(tmpdir(), "nlm-ss-")), "nlm-memory");
    execFileSync("git", ["init", "-q", "-b", "fix/opencode-capture", repo]);
    run("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "fix(adapters): opencode xdg db path");
  });

  afterEach(() => rmSync(join(repo, ".."), { recursive: true, force: true }));

  it("a single-word directory alone is rejected by the extractor", () => {
    expect(extractRecallQuery(buildQuery(repo, "", ""))).toBeNull();
  });

  it("branch and commit subjects give the extractor enough to query", () => {
    const query = buildQuery(repo, "", readGitContext(repo));
    expect(query).toContain("opencode capture");
    expect(query).toContain("opencode xdg db path");
    expect(extractRecallQuery(query)).not.toBeNull();
  });

  it("returns no context outside a git repo", () => {
    expect(readGitContext(join(repo, ".."))).toBe("");
  });
});
