/**
 * persistReDerivationPairs (#405 review): the pairs cache must be written
 * via write-temp-then-rename, never directly to the final path - the
 * outcome adapters read that path on every get_session, so a crash
 * mid-write must not be able to leave truncated JSON behind. node:fs is
 * partially mocked with passthrough spies because nlm.ts binds the fs
 * functions as named ESM imports, which a plain object spy cannot observe.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync: vi.fn(actual.writeFileSync),
    renameSync: vi.fn(actual.renameSync),
  };
});

import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { persistReDerivationPairs } from "../../../src/cli/nlm.js";

// computeReDerivationRate only needs prepare().all(); empty result sets are
// enough here since this test is about the write path, not the metric.
const stubDb = { prepare: () => ({ all: () => [] }) };

describe("persistReDerivationPairs atomic write", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-pairs-atomic-"));
    vi.mocked(writeFileSync).mockClear();
    vi.mocked(renameSync).mockClear();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("writes a same-directory temp file and renames it over the final path", async () => {
    const pairsPath = join(tmp, "re-derivation-pairs.json");
    await persistReDerivationPairs(stubDb, pairsPath, 42);

    const writeTargets = vi.mocked(writeFileSync).mock.calls.map((c) => c[0]);
    expect(writeTargets).not.toContain(pairsPath);
    const tempTarget = writeTargets.find(
      (p): p is string => typeof p === "string" && p.startsWith(`${pairsPath}.tmp-`),
    );
    expect(tempTarget).toBeDefined();
    expect(vi.mocked(renameSync)).toHaveBeenCalledWith(tempTarget, pairsPath);

    expect(JSON.parse(readFileSync(pairsPath, "utf8"))).toEqual([]);
    expect(existsSync(tempTarget as string)).toBe(false);
  });
});
