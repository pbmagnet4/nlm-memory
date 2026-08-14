/**
 * The hook entry-point guard must survive being invoked through a symlinked
 * install path.
 *
 * Every hook ends with an "am I the entry point" check. The original form
 * compared import.meta.url against pathToFileURL(process.argv[1]) directly.
 * Node realpath-resolves import.meta.url but leaves argv[1] as the literal
 * string it was invoked with, so any symlinked path made the two disagree,
 * the guard went false, main() never ran, and the hook exited 0 having done
 * nothing — no output, no log, no error.
 *
 * That is not hypothetical. A versioned install with a `current` -> versions/X
 * pointer (the NxtOS layout) invokes hooks through exactly such a symlink, so
 * pointing hooks at `current` silently disabled all session capture while
 * every hook still reported success.
 */

import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isMainModule } from "../../../src/hook/hook-helpers.js";

describe("isMainModule", () => {
  let dir: string;
  let realDir: string;
  let realFile: string;
  let linkDir: string;
  let linkFile: string;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "nlm-mainmod-")));
    realDir = join(dir, "versions", "1.0.0");
    mkdirSync(realDir, { recursive: true });
    realFile = join(realDir, "hook.js");
    writeFileSync(realFile, "// hook\n");

    linkDir = join(dir, "current");
    symlinkSync(realDir, linkDir);
    linkFile = join(linkDir, "hook.js");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("is true when invoked by its real path", () => {
    const metaUrl = pathToFileURL(realFile).href;
    expect(isMainModule(metaUrl, realFile)).toBe(true);
  });

  it("is true when invoked through a symlinked directory", () => {
    // import.meta.url is always the realpath-resolved form...
    const metaUrl = pathToFileURL(realFile).href;
    // ...while argv[1] is the literal symlinked path the caller typed.
    expect(isMainModule(metaUrl, linkFile)).toBe(true);
  });

  it("is false for an unrelated module", () => {
    const other = join(realDir, "other.js");
    writeFileSync(other, "// other\n");
    const metaUrl = pathToFileURL(other).href;
    expect(isMainModule(metaUrl, realFile)).toBe(false);
  });

  it("is false when argv[1] is absent (imported, not executed)", () => {
    const metaUrl = pathToFileURL(realFile).href;
    expect(isMainModule(metaUrl, undefined)).toBe(false);
  });

  it("does not throw when argv[1] points at a nonexistent path", () => {
    const metaUrl = pathToFileURL(realFile).href;
    expect(() => isMainModule(metaUrl, join(dir, "gone.js"))).not.toThrow();
    expect(isMainModule(metaUrl, join(dir, "gone.js"))).toBe(false);
  });
});
