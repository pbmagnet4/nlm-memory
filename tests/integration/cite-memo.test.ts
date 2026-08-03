import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearCited,
  loadCited,
  recordCited,
} from "../../src/core/hook/cite-memo.js";
import { DEFAULT_TEAM_ID } from "../../src/core/tenancy/default-team.js";

describe("cite-memo", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-cite-memo-"));
    process.env["NLM_HOOK_STATE_DIR"] = tmp;
  });

  afterEach(() => {
    delete process.env["NLM_HOOK_STATE_DIR"];
    rmSync(tmp, { recursive: true, force: true });
  });

  it("loadCited returns empty set when no memo file exists", () => {
    expect(loadCited(DEFAULT_TEAM_ID, "conv-x").size).toBe(0);
  });

  it("recordCited persists ids; loadCited returns them on next call", () => {
    recordCited(DEFAULT_TEAM_ID, "conv-x", ["cc_a", "cc_b"]);
    expect(loadCited(DEFAULT_TEAM_ID, "conv-x")).toEqual(new Set(["cc_a", "cc_b"]));
  });

  it("recordCited unions across calls (does not overwrite)", () => {
    recordCited(DEFAULT_TEAM_ID, "conv-x", ["cc_a"]);
    recordCited(DEFAULT_TEAM_ID, "conv-x", ["cc_b", "cc_a"]);
    expect(loadCited(DEFAULT_TEAM_ID, "conv-x")).toEqual(new Set(["cc_a", "cc_b"]));
  });

  it("recordCited with empty list is a no-op (no file created)", () => {
    recordCited(DEFAULT_TEAM_ID, "conv-empty", []);
    expect(readdirSync(tmp).filter((f) => f.startsWith("conv-empty"))).toEqual([]);
  });

  it("clearCited removes the file and returns true; second call returns false", () => {
    recordCited(DEFAULT_TEAM_ID, "conv-x", ["cc_a"]);
    expect(clearCited(DEFAULT_TEAM_ID, "conv-x")).toBe(true);
    expect(clearCited(DEFAULT_TEAM_ID, "conv-x")).toBe(false);
    expect(loadCited(DEFAULT_TEAM_ID, "conv-x").size).toBe(0);
  });

  it("uses .cited.json filename suffix — parallel to surfaced memo's .json", () => {
    recordCited(DEFAULT_TEAM_ID, "conv-x", ["cc_a"]);
    const files = readdirSync(tmp);
    expect(files).toContain("conv-x.cited.json");
  });

  it("treats corrupt JSON as empty without throwing", () => {
    writeFileSync(join(tmp, "conv-bad.cited.json"), "not json", "utf8");
    expect(loadCited(DEFAULT_TEAM_ID, "conv-bad").size).toBe(0);
  });

  it("treats non-array JSON as empty without throwing", () => {
    writeFileSync(
      join(tmp, "conv-obj.cited.json"),
      JSON.stringify({ cc_a: 1 }),
      "utf8",
    );
    expect(loadCited(DEFAULT_TEAM_ID, "conv-obj").size).toBe(0);
  });

  it("filters out non-string entries from the persisted array", () => {
    writeFileSync(
      join(tmp, "conv-mixed.cited.json"),
      JSON.stringify(["cc_a", 42, null, "cc_b"]),
      "utf8",
    );
    expect(loadCited(DEFAULT_TEAM_ID, "conv-mixed")).toEqual(new Set(["cc_a", "cc_b"]));
  });

  it("sanitizes unsafe conversation IDs so the path stays inside the state dir", () => {
    recordCited(DEFAULT_TEAM_ID, "../escape/attempt", ["cc_a"]);
    const files = readdirSync(tmp);
    // No file at ../escape/attempt should exist; conversion replaces unsafe chars.
    expect(files.some((f) => f.endsWith(".cited.json"))).toBe(true);
    expect(files).not.toContain("..");
  });
});

describe("cite-memo.ts tenant path contract", () => {
  afterEach(() => {
    delete process.env["NLM_HOOK_STATE_DIR"];
  });

  it("default team honors NLM_HOOK_STATE_DIR override (legacy behavior)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "nlm-cite-memo-tenant-"));
    process.env["NLM_HOOK_STATE_DIR"] = tmp;
    try {
      recordCited(DEFAULT_TEAM_ID, "conv-1", ["cc_a"]);
      expect(existsSync(join(tmp, "conv-1.cited.json"))).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("a non-default tenant writes under ~/.nlm/tenants/<t>/hook-state/, ignoring NLM_HOOK_STATE_DIR", () => {
    const tmp = mkdtempSync(join(tmpdir(), "nlm-cite-memo-tenant-"));
    process.env["NLM_HOOK_STATE_DIR"] = tmp;
    const derived = join(homedir(), ".nlm", "tenants", "acme-citememo-test", "hook-state", "conv-1.cited.json");
    try {
      recordCited("acme-citememo-test", "conv-1", ["cc_a"]);
      expect(existsSync(join(tmp, "conv-1.cited.json"))).toBe(false);
      expect(existsSync(derived)).toBe(true);
    } finally {
      clearCited("acme-citememo-test", "conv-1");
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("two tenants citing the same conversation id do not collide", () => {
    try {
      recordCited("tenant-a-citememo", "conv-shared", ["cc_a"]);
      recordCited("tenant-b-citememo", "conv-shared", ["cc_b"]);
      expect([...loadCited("tenant-a-citememo", "conv-shared")]).toEqual(["cc_a"]);
      expect([...loadCited("tenant-b-citememo", "conv-shared")]).toEqual(["cc_b"]);
    } finally {
      clearCited("tenant-a-citememo", "conv-shared");
      clearCited("tenant-b-citememo", "conv-shared");
    }
  });
});
