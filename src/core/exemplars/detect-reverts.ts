/**
 * Revert detection for code exemplars.
 *
 * Capture labels every committed chunk "pass" (committed = accepted), so the
 * corpus can never warn against code that was later reverted. This module
 * closes that loop: stock `git revert` commits carry a "This reverts commit
 * <sha>." trailer, so a sweep over the exemplar's repo finds exactly the
 * commits that were undone — no heuristics, no LLM judge.
 *
 * Pure except for the injected git runner and fs exists check, so tests run
 * against throwaway repos.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";

export type GitRunner = (repoPath: string, args: ReadonlyArray<string>) => string;

const GIT_MAX_BUFFER = 64 * 1024 * 1024;

export function defaultGitRunner(repoPath: string, args: ReadonlyArray<string>): string {
  return execFileSync("git", [...args], {
    cwd: repoPath,
    encoding: "utf8",
    maxBuffer: GIT_MAX_BUFFER,
  }).trim();
}

/** Project roots searched when resolving an exemplar's repo basename. */
export function defaultProjectRoots(): string[] {
  const env = process.env["NLM_PROJECT_ROOTS"];
  if (env) return env.split(":").filter((s) => s.length > 0);
  const home = homedir();
  return [join(home, "Documents", "Coding Projects"), join(home, ".projects")];
}

/**
 * Resolve an exemplar repo basename to a working copy. Rejects anything that
 * is not a plain directory name. Returns null when no known root holds it.
 */
export function resolveRepoPath(
  basename: string,
  roots: ReadonlyArray<string>,
  exists: (path: string) => boolean = existsSync,
): string | null {
  if (!isPlainName(basename)) return null;
  for (const root of roots) {
    const candidate = join(root, basename);
    if (exists(join(candidate, ".git"))) return candidate;
  }
  return null;
}

function isPlainName(basename: string): boolean {
  return (
    basename.length > 0 &&
    !basename.includes("/") &&
    !basename.includes(sep) &&
    basename !== "." &&
    basename !== ".."
  );
}

/**
 * Index every git working copy up to maxDepth under the roots, keyed by
 * directory basename. One walk per sweep instead of one filesystem probe
 * per exemplar repo — and it finds nested checkouts (subproject dirs,
 * archives) the flat join misses.
 */
export function indexGitRepos(
  roots: ReadonlyArray<string>,
  maxDepth = 3,
  exists: (path: string) => boolean = existsSync,
): Map<string, string[]> {
  const index = new Map<string, string[]>();
  const visit = (dir: string, name: string, depth: number): void => {
    if (depth > maxDepth) return;
    if (depth > 0 && !isPlainName(name)) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") {
        continue;
      }
      const full = join(dir, entry.name);
      if (exists(join(full, ".git"))) {
        const list = index.get(entry.name) ?? [];
        list.push(full);
        index.set(entry.name, list);
      }
      visit(full, entry.name, depth + 1);
    }
  };
  for (const root of roots) visit(root, "", 0);
  return index;
}

/**
 * Unique-index resolution: exactly one checkout with this basename, else
 * null (absent or ambiguous — a verdict must never attach to the wrong repo).
 */
export function resolveRepoPathIndexed(
  basename: string,
  index: ReadonlyMap<string, ReadonlyArray<string>>,
): string | null {
  if (!isPlainName(basename)) return null;
  const matches = index.get(basename) ?? [];
  return matches.length === 1 ? (matches[0] as string) : null;
}

const FULL_SHA = /\b[0-9a-f]{40}\b/g;
// NUL (field) and RS (record) separators as git %x escapes: the arg carries
// only literal %x text (Node refuses real NUL bytes in spawn args); git emits
// the control chars in its output, which JS strings hold fine.
const FORMAT = "--format=%H%x00%s%x00%b%x1e";
const FIELD_SEP = String.fromCharCode(0);
const RECORD_SEP = String.fromCharCode(30);

/**
 * Full shas undone by stock `git revert` commits in the repo. Only commits
 * whose subject starts with "Revert " contribute — custom revert messages
 * without the trailer are out of scope by design (no guessing).
 */
export function listRevertedShas(repoPath: string, git: GitRunner = defaultGitRunner): Set<string> {
  const raw = git(repoPath, ["log", "--all", FORMAT]);
  const out = new Set<string>();
  for (const record of raw.split(RECORD_SEP)) {
    if (!record) continue;
    const parts = record.split(FIELD_SEP);
    const subj = parts[1] ?? "";
    const body = parts.slice(2).join("");
    if (/^Revert\b/.test(subj)) {
      for (const m of body.matchAll(FULL_SHA)) out.add(m[0]);
    }
  }
  return out;
}

export interface RevertCandidate {
  readonly id: string;
  readonly repo: string;
  readonly gitSha: string | null;
}

/**
 * Exemplar ids whose commit was reverted. Short shas match by prefix in
 * either direction; stubs under 7 chars never match (collision risk).
 */
export function findRevertedIds(
  candidates: ReadonlyArray<RevertCandidate>,
  revertedByRepo: ReadonlyMap<string, ReadonlySet<string>>,
): string[] {
  const out: string[] = [];
  for (const c of candidates) {
    const reverted = revertedByRepo.get(c.repo);
    if (!reverted || reverted.size === 0) continue;
    const sha = (c.gitSha ?? "").trim().toLowerCase();
    if (sha.length < 7 || !/^[0-9a-f]+$/.test(sha)) continue;
    for (const full of reverted) {
      if (full.startsWith(sha) || sha.startsWith(full)) {
        out.push(c.id);
        break;
      }
    }
  }
  return out;
}
