import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CodeExemplarStore } from "../../../../src/ports/code-exemplar-store.js";
import { runBackfillExemplarOutcomes } from "../../../../src/core/exemplars/backfill-outcomes.js";

function fakeStore() {
  const verdicts: { id: string }[] = [];
  const store = {
    verdicts,
    listByOutcome: async (_tenant: string, outcome: string) =>
      outcome === "pass"
        ? [
            { id: "e1", repo: "proj", gitSha: "a".repeat(40) },
            { id: "e2", repo: "proj", gitSha: "b".repeat(40) },
            { id: "e3", repo: "gone", gitSha: "c".repeat(40) },
            { id: "e4", repo: "proj", gitSha: null },
          ]
        : [],
    setVerdict: async (_t: string, id: string) => {
      verdicts.push({ id });
      return { status: "applied" as const };
    },
  };
  return store as unknown as Pick<CodeExemplarStore, "listByOutcome" | "setVerdict"> & {
    verdicts: { id: string }[];
  };
}

const NUL = String.fromCharCode(0);
const RS = String.fromCharCode(30);
// Real git-log shape: hash, subject, body separated by NUL, records by RS.
const LOG =
  `zzz${NUL}Revert "bad change"${NUL}This reverts commit ${"a".repeat(40)}.${RS}` +
  `yyy${NUL}add good thing${NUL}plain body${RS}`;

const GIT = () => LOG;

describe("runBackfillExemplarOutcomes", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "nlm-bb-"));
    execFileSync("git", ["init", "-q", join(root, "proj")]);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("marks reverted pass exemplars as fail and skips the rest", async () => {
    const store = fakeStore();
    const report = await runBackfillExemplarOutcomes({
      store,
      tenantId: "team_local",
      roots: [root],
      git: GIT,
    });
    expect(report.checked).toBe(4);
    expect(report.withSha).toBe(3);
    expect(report.reposResolved).toBe(1);
    expect(report.reposSkipped).toEqual(["gone"]);
    expect(report.revertedFound).toBe(1);
    expect(report.markedFail).toBe(1);
    expect(store.verdicts.map((v) => v.id)).toEqual(["e1"]);
  });

  it("dry-run reports without writing", async () => {
    const store = fakeStore();
    const report = await runBackfillExemplarOutcomes({
      store,
      tenantId: "team_local",
      roots: [root],
      git: GIT,
      dryRun: true,
    });
    expect(report.dryRun).toBe(true);
    expect(report.revertedFound).toBe(1);
    expect(report.markedFail).toBe(0);
    expect(store.verdicts).toEqual([]);
  });
});
