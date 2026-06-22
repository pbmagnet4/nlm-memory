import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearSurfaced,
  loadSurfaced,
  recordSurfaced,
  resolveConversationForSession,
} from "../../src/core/hook/memo.js";

describe("hook memo", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-memo-"));
    process.env["NLM_HOOK_STATE_DIR"] = tmp;
  });

  afterEach(() => {
    delete process.env["NLM_HOOK_STATE_DIR"];
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns an empty set for an unknown conversation", () => {
    expect(loadSurfaced("conv-1").size).toBe(0);
  });

  it("records and reloads surfaced ids", () => {
    recordSurfaced("conv-1", ["sess_a", "sess_b"]);
    const got = loadSurfaced("conv-1");
    expect([...got].sort()).toEqual(["sess_a", "sess_b"]);
  });

  it("accumulates across multiple records and dedups", () => {
    recordSurfaced("conv-1", ["sess_a"]);
    recordSurfaced("conv-1", ["sess_a", "sess_c"]);
    expect([...loadSurfaced("conv-1")].sort()).toEqual(["sess_a", "sess_c"]);
  });

  it("isolates conversations from each other", () => {
    recordSurfaced("conv-1", ["sess_a"]);
    recordSurfaced("conv-2", ["sess_z"]);
    expect([...loadSurfaced("conv-1")]).toEqual(["sess_a"]);
    expect([...loadSurfaced("conv-2")]).toEqual(["sess_z"]);
  });

  it("loadSurfaced returns empty on a corrupt memo file rather than throwing", () => {
    recordSurfaced("conv-1", ["sess_a"]);
    // overwrite with garbage
    writeFileSync(join(tmp, "conv-1.json"), "{not json", "utf8");
    expect(loadSurfaced("conv-1").size).toBe(0);
  });

  it("clearSurfaced deletes the memo file and returns true", () => {
    recordSurfaced("conv-1", ["sess_a"]);
    expect(loadSurfaced("conv-1").size).toBe(1);
    expect(clearSurfaced("conv-1")).toBe(true);
    expect(loadSurfaced("conv-1").size).toBe(0);
  });

  it("clearSurfaced returns false when no memo file exists", () => {
    expect(clearSurfaced("never-existed")).toBe(false);
  });

  it("clearSurfaced isolates conversations — only deletes the targeted one", () => {
    recordSurfaced("conv-1", ["sess_a"]);
    recordSurfaced("conv-2", ["sess_b"]);
    clearSurfaced("conv-1");
    expect(loadSurfaced("conv-1").size).toBe(0);
    expect([...loadSurfaced("conv-2")]).toEqual(["sess_b"]);
  });

  // #345 — server-side conversation attribution for cite_session: the agent
  // rarely passes conversation_id, so the daemon resolves it from the memo.
  it("resolveConversationForSession finds the conversation that surfaced a session", () => {
    recordSurfaced("conv-1", ["sess_a", "sess_b"]);
    recordSurfaced("conv-2", ["sess_z"]);
    expect(resolveConversationForSession("sess_a")).toBe("conv-1");
    expect(resolveConversationForSession("sess_z")).toBe("conv-2");
  });

  it("resolveConversationForSession returns null when no conversation surfaced it", () => {
    recordSurfaced("conv-1", ["sess_a"]);
    expect(resolveConversationForSession("never_surfaced")).toBeNull();
  });

  it("resolveConversationForSession picks the MOST RECENT surfacing conversation", () => {
    recordSurfaced("conv-old", ["sess_shared"]);
    recordSurfaced("conv-new", ["sess_shared"]);
    // Force conv-old to be older so the tie is deterministic.
    const past = new Date(Date.now() - 60_000);
    utimesSync(join(tmp, "conv-old.json"), past, past);
    expect(resolveConversationForSession("sess_shared")).toBe("conv-new");
  });
});
