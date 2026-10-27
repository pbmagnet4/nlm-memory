import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findRevertedIds,
  indexGitRepos,
  listRevertedShas,
  resolveRepoPath,
  resolveRepoPathIndexed,
} from "../../../../src/core/exemplars/detect-reverts.js";

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

function initRepoAt(repo: string): void {
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "t@t.test");
  git(repo, "config", "user.name", "t");
}

describe("listRevertedShas", () => {
  let repo: string;
  let goodSha: string;
  let badSha: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "nlm-revert-"));
    git(repo, "init", "-q");
    git(repo, "config", "user.email", "t@t.test");
    git(repo, "config", "user.name", "t");
    writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
    git(repo, "add", "a.ts");
    git(repo, "commit", "-q", "-m", "add a");
    goodSha = git(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "b.ts"), "export const b = 2;\n");
    git(repo, "add", "b.ts");
    git(repo, "commit", "-q", "-m", "add b");
    badSha = git(repo, "rev-parse", "HEAD");
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("finds the reverted commit and not the live one", () => {
    git(repo, "revert", "--no-edit", badSha);
    const reverted = listRevertedShas(repo);
    expect(reverted.has(badSha)).toBe(true);
    expect(reverted.has(goodSha)).toBe(false);
  });

  it("returns empty when nothing was reverted", () => {
    expect(listRevertedShas(repo).size).toBe(0);
  });
});

describe("resolveRepoPath", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "nlm-roots-"));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("resolves a basename under a known root", () => {
    const repo = join(root, "my-proj");
    initRepoAt(repo);
    expect(resolveRepoPath("my-proj", [root])).toBe(repo);
  });

  it("returns null when the repo is absent", () => {
    expect(resolveRepoPath("missing", [root])).toBeNull();
  });

  it("rejects traversal and nested names", () => {
    expect(resolveRepoPath("../x", [root])).toBeNull();
    expect(resolveRepoPath("a/b", [root])).toBeNull();
    expect(resolveRepoPath("", [root])).toBeNull();
  });
});

describe("indexGitRepos + resolveRepoPathIndexed", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "nlm-idx-"));
    initRepoAt(join(root, "proj"));
    initRepoAt(join(root, "sub", "nested"));
    initRepoAt(join(root, "a", "dup"));
    initRepoAt(join(root, "b", "dup"));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("finds nested checkouts and refuses ambiguous names", () => {
    const index = indexGitRepos([root]);
    expect(resolveRepoPathIndexed("proj", index)).toBe(join(root, "proj"));
    expect(resolveRepoPathIndexed("nested", index)).toBe(join(root, "sub", "nested"));
    expect(resolveRepoPathIndexed("dup", index)).toBeNull();
    expect(resolveRepoPathIndexed("missing", index)).toBeNull();
  });
});

describe("findRevertedIds", () => {
  const full = "abcdef1234567890abcdef1234567890abcdef12";
  const revertedByRepo = new Map([["proj", new Set([full])]]);

  it("matches full and short shas", () => {
    const rows = [
      { id: "e1", repo: "proj", gitSha: full },
      { id: "e2", repo: "proj", gitSha: full.slice(0, 8) },
      { id: "e3", repo: "proj", gitSha: "0000000000000000000000000000000000000000" },
      { id: "e4", repo: "other", gitSha: full },
    ];
    expect(findRevertedIds(rows, revertedByRepo)).toEqual(["e1", "e2"]);
  });

  it("ignores stubs shorter than 7 chars", () => {
    const rows = [{ id: "e9", repo: "proj", gitSha: "abc" }];
    expect(findRevertedIds(rows, revertedByRepo)).toEqual([]);
  });
});
