import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  END_SENTINEL,
  RULES_BLOCK,
  START_SENTINEL,
  removeRulesBlock,
  upsertRulesBlock,
} from "../../../src/install/rules-content.js";

describe("upsertRulesBlock", () => {
  let dir: string;
  let target: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nlm-rules-"));
    target = join(dir, "subdir", "rules.md");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates the file (and parent dirs) when target is missing", () => {
    const result = upsertRulesBlock(target);
    expect(result.action).toBe("created");
    expect(existsSync(target)).toBe(true);
    const content = readFileSync(target, "utf8");
    expect(content).toContain(START_SENTINEL);
    expect(content).toContain(END_SENTINEL);
    expect(content).toContain(RULES_BLOCK.split("\n")[0]);
  });

  it("appends the block when file exists without a managed block", () => {
    writeFileSync(target.replace("/subdir/", "/"), "# Existing user rules\n\nKeep these.\n");
    const userFile = target.replace("/subdir/", "/");
    const result = upsertRulesBlock(userFile);
    expect(result.action).toBe("appended");
    const content = readFileSync(userFile, "utf8");
    expect(content.startsWith("# Existing user rules")).toBe(true);
    expect(content).toContain(START_SENTINEL);
    expect(content).toContain(END_SENTINEL);
    expect(content.indexOf("Keep these.")).toBeLessThan(content.indexOf(START_SENTINEL));
  });

  it("replaces an existing managed block in place, preserving surrounding content", () => {
    const userFile = target.replace("/subdir/", "/");
    const before = "# Top\n\n";
    const after = "\n# Bottom\n";
    writeFileSync(userFile, `${before}${START_SENTINEL}\nOLD CONTENT\n${END_SENTINEL}\n${after}`);
    const result = upsertRulesBlock(userFile);
    expect(result.action).toBe("replaced");
    const content = readFileSync(userFile, "utf8");
    expect(content).toContain("# Top");
    expect(content).toContain("# Bottom");
    expect(content).not.toContain("OLD CONTENT");
    expect(content).toContain(RULES_BLOCK.split("\n")[0]);
    // Exactly one managed block
    expect(content.match(new RegExp(START_SENTINEL, "g"))!.length).toBe(1);
  });

  it("is idempotent on re-invocation against the same target", () => {
    const r1 = upsertRulesBlock(target);
    const c1 = readFileSync(target, "utf8");
    const r2 = upsertRulesBlock(target);
    const c2 = readFileSync(target, "utf8");
    expect(r1.action).toBe("created");
    expect(r2.action).toBe("unchanged");
    expect(c1).toBe(c2);
  });
});

describe("removeRulesBlock", () => {
  let dir: string;
  let target: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nlm-rules-"));
    target = join(dir, "rules.md");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("no-ops when target file does not exist", () => {
    const result = removeRulesBlock(target);
    expect(result.action).toBe("no-file");
    expect(existsSync(target)).toBe(false);
  });

  it("no-ops when file exists but contains no managed block", () => {
    writeFileSync(target, "# Just user content\n");
    const result = removeRulesBlock(target);
    expect(result.action).toBe("not-present");
    expect(readFileSync(target, "utf8")).toBe("# Just user content\n");
  });

  it("deletes the file if the managed block was the only content", () => {
    upsertRulesBlock(target);
    const result = removeRulesBlock(target);
    expect(result.action).toBe("deleted-file");
    expect(existsSync(target)).toBe(false);
  });

  it("strips the managed block, leaving surrounding user content intact", () => {
    const before = "# Top\nuser stuff\n";
    const after = "# Bottom\nmore user stuff\n";
    writeFileSync(
      target,
      `${before}\n${START_SENTINEL}\n${RULES_BLOCK}${END_SENTINEL}\n\n${after}`,
    );
    const result = removeRulesBlock(target);
    expect(result.action).toBe("removed");
    const content = readFileSync(target, "utf8");
    expect(content).toContain("# Top");
    expect(content).toContain("user stuff");
    expect(content).toContain("# Bottom");
    expect(content).toContain("more user stuff");
    expect(content).not.toContain(START_SENTINEL);
    expect(content).not.toContain(END_SENTINEL);
  });
});
