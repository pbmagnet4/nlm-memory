import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FsWikiWriter, WikiOwnershipError, SENTINEL_FILE } from "@core/adapters/fs-wiki-writer.js";
import { MemoryWikiWriter } from "@core/adapters/memory-wiki-writer.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nlm-wiki-test-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("FsWikiWriter", () => {
  it("creates the root and its sentinel on first write", async () => {
    const target = join(root, "Memory");
    const w = new FsWikiWriter(target);
    await w.write("a.md", "hello");
    expect(readFileSync(join(target, "a.md"), "utf8")).toBe("hello");
    expect(existsSync(join(target, SENTINEL_FILE))).toBe(true);
  });

  it("adopts an empty existing directory", async () => {
    const w = new FsWikiWriter(root);
    await w.write("a.md", "hello");
    expect(readFileSync(join(root, "a.md"), "utf8")).toBe("hello");
  });

  it("refuses a non-empty directory it does not own", async () => {
    writeFileSync(join(root, "my-notes.md"), "human wrote this");
    const w = new FsWikiWriter(root);
    await expect(w.write("a.md", "hello")).rejects.toBeInstanceOf(WikiOwnershipError);
    expect(readFileSync(join(root, "my-notes.md"), "utf8")).toBe("human wrote this");
  });

  it("accepts a non-empty directory that carries its sentinel", async () => {
    writeFileSync(join(root, SENTINEL_FILE), "owned by nlm");
    writeFileSync(join(root, "old.md"), "previous run");
    const w = new FsWikiWriter(root);
    await w.write("a.md", "hello");
    expect(readFileSync(join(root, "a.md"), "utf8")).toBe("hello");
  });

  it("lists only markdown files and excludes the sentinel", async () => {
    const w = new FsWikiWriter(root);
    await w.write("a.md", "a");
    await w.write("b.md", "b");
    writeFileSync(join(root, "notes.txt"), "not markdown");
    const listed = await w.list();
    expect([...listed].sort()).toEqual(["a.md", "b.md"]);
  });

  it("reads back what it wrote", async () => {
    const w = new FsWikiWriter(root);
    await w.write("a.md", "hello");
    expect(await w.read("a.md")).toBe("hello");
  });

  it("returns null reading a file that is not there", async () => {
    const w = new FsWikiWriter(root);
    await w.write("a.md", "hello");
    expect(await w.read("missing.md")).toBeNull();
  });

  it("removes a file", async () => {
    const w = new FsWikiWriter(root);
    await w.write("a.md", "a");
    await w.remove("a.md");
    expect(existsSync(join(root, "a.md"))).toBe(false);
  });

  it("ignores removal of a file that is already gone", async () => {
    const w = new FsWikiWriter(root);
    await w.write("a.md", "a");
    await expect(w.remove("missing.md")).resolves.toBeUndefined();
  });

  it("rejects a relative path that escapes the root", async () => {
    const w = new FsWikiWriter(root);
    await w.write("a.md", "a");
    await expect(w.write("../escape.md", "x")).rejects.toBeInstanceOf(WikiOwnershipError);
    expect(existsSync(join(root, "..", "escape.md"))).toBe(false);
  });

  it("does not treat a nested directory as ownership evidence", async () => {
    mkdirSync(join(root, "sub"));
    const w = new FsWikiWriter(root);
    await expect(w.write("a.md", "hello")).rejects.toBeInstanceOf(WikiOwnershipError);
  });
});

describe("MemoryWikiWriter", () => {
  it("round-trips write, list, and remove", async () => {
    const w = new MemoryWikiWriter();
    await w.write("a.md", "a");
    await w.write("b.md", "b");
    expect([...(await w.list())].sort()).toEqual(["a.md", "b.md"]);
    expect(await w.read("a.md")).toBe("a");
    expect(await w.read("nope.md")).toBeNull();
    await w.remove("a.md");
    expect(await w.list()).toEqual(["b.md"]);
    expect(w.files.get("b.md")).toBe("b");
  });
});
