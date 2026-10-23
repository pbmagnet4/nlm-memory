/**
 * Backfill exemplar outcomes from git history.
 *
 * Capture labels every committed chunk "pass", so the corpus can never warn
 * against code that was later reverted. This sweep closes that loop: for
 * every pass exemplar with a git sha, resolve its repo, collect the shas
 * undone by stock `git revert` commits, and relabel matches as "fail"
 * (source "llm", so a human verdict still wins). Recall then surfaces them
 * as negatives instead of positive guidance.
 */

import type { CodeExemplarStore } from "@ports/code-exemplar-store.js";
import {
  defaultGitRunner,
  defaultProjectRoots,
  findRevertedIds,
  indexGitRepos,
  listRevertedShas,
  resolveRepoPathIndexed,
  type GitRunner,
} from "./detect-reverts.js";

export interface BackfillOutcomesOptions {
  readonly store: Pick<CodeExemplarStore, "listByOutcome" | "setVerdict">;
  readonly tenantId: string;
  readonly roots?: ReadonlyArray<string>;
  readonly git?: GitRunner;
  readonly exists?: (path: string) => boolean;
  readonly limit?: number;
  readonly dryRun?: boolean;
  readonly onProgress?: (msg: string) => void;
}

export interface BackfillOutcomesReport {
  readonly checked: number;
  readonly withSha: number;
  readonly reposResolved: number;
  readonly reposSkipped: string[];
  readonly revertedFound: number;
  readonly markedFail: number;
  readonly dryRun: boolean;
}

export async function runBackfillExemplarOutcomes(
  opts: BackfillOutcomesOptions,
): Promise<BackfillOutcomesReport> {
  const git = opts.git ?? defaultGitRunner;
  const roots = opts.roots ?? defaultProjectRoots();
  const all = await opts.store.listByOutcome(opts.tenantId, "pass");
  const scoped = opts.limit !== undefined ? all.slice(0, opts.limit) : all;
  const withSha = scoped.filter((e) => e.gitSha && e.gitSha.trim().length > 0);

  const byRepo = new Map<string, { id: string; gitSha: string }[]>();
  for (const e of withSha) {
    const list = byRepo.get(e.repo) ?? [];
    list.push({ id: e.id, gitSha: e.gitSha as string });
    byRepo.set(e.repo, list);
  }

  const revertedByRepo = new Map<string, Set<string>>();
  const skipped: string[] = [];
  const index = indexGitRepos(roots, 3, opts.exists);
  for (const repo of byRepo.keys()) {
    const candidates = index.get(repo) ?? [];
    const path = resolveRepoPathIndexed(repo, index);
    if (!path) {
      skipped.push(candidates.length > 1 ? `${repo} (ambiguous: ${candidates.length})` : repo);
      opts.onProgress?.(
        candidates.length > 1
          ? `skip ${repo}: ${candidates.length} checkouts, refusing to guess`
          : `skip ${repo}: not under project roots`,
      );
      continue;
    }
    try {
      revertedByRepo.set(repo, listRevertedShas(path, git));
    } catch (err) {
      skipped.push(repo);
      opts.onProgress?.(`skip ${repo}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const ids = findRevertedIds(
    [...byRepo.entries()].flatMap(([repo, rows]) => rows.map((r) => ({ ...r, repo }))),
    revertedByRepo,
  );

  let markedFail = 0;
  if (!opts.dryRun) {
    for (const id of ids) {
      const res = await opts.store.setVerdict(opts.tenantId, id, { outcome: "fail" }, "llm");
      if (res.status === "applied") markedFail += 1;
    }
  }

  return {
    checked: scoped.length,
    withSha: withSha.length,
    reposResolved: revertedByRepo.size,
    reposSkipped: skipped,
    revertedFound: ids.length,
    markedFail: opts.dryRun ? 0 : markedFail,
    dryRun: opts.dryRun ?? false,
  };
}
