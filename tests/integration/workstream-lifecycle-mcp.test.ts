import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import { makeSession } from "../fixtures/sessions.js";
import { listMergeSuggestionsHandler, mergeWorkstreamsHandler, rebindSessionHandler, renameWorkstreamHandler, retireWorkstreamHandler } from "../../src/mcp/server.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");
let storage: SqliteStorage;
let tmp: string;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "nlm-lcmcp-"));
  storage = SqliteStorage.create({
    dbPath: join(tmp, "canonical.sqlite"),
    migrationsDir: MIGRATIONS_DIR,
  });
  await storage.init();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

function deps() {
  return {
    recall: {} as never,
    store: storage.sessions,
    workstreams: {
      store: storage.workstreams,
      sessions: storage.sessions,
      facts: storage.facts,
      exemplars: storage.exemplars,
    },
  } as never;
}

describe("rebind_session handler", () => {
  it("binds a session to a workstream with operator provenance", async () => {
    storage.sessions.insertSessionForTest(makeSession({ id: "s1" }));
    await storage.workstreams.create("team_local", { id: "ws_1", label: "NLM", scope: null });
    const r = await rebindSessionHandler(deps(), { sessionId: "s1", workstream: "NLM" });
    expect(r.isError).not.toBe(true);
    const ids = await storage.sessions.getWorkstreamIds("team_local", ["s1"]);
    expect(ids.get("s1")).toBe("ws_1");
  });

  it("returns a graceful message when the workstream is unknown", async () => {
    storage.sessions.insertSessionForTest(makeSession({ id: "s1" }));
    const r = await rebindSessionHandler(deps(), { sessionId: "s1", workstream: "Nope" });
    expect(r.isError).not.toBe(true);
    expect(r.content[0]!.text.toLowerCase()).toContain("no workstream");
  });

  it("returns unavailable when workstreams deps are not wired", async () => {
    const r = await rebindSessionHandler(
      { recall: {}, store: storage.sessions } as never,
      { sessionId: "s1", workstream: "NLM" },
    );
    expect(r.content[0]!.text.toLowerCase()).toContain("not available");
  });
});

describe("merge_workstreams handler", () => {
  it("merges from into into and resolves the chain", async () => {
    await storage.workstreams.create("team_local", { id: "ws_from", label: "Dup", scope: null });
    await storage.workstreams.create("team_local", { id: "ws_into", label: "Keep", scope: null });
    const r = await mergeWorkstreamsHandler(deps(), { from: "Dup", into: "Keep" });
    expect(r.isError).not.toBe(true);
    const from = await storage.workstreams.getById("team_local", "ws_from");
    expect(from!.mergedInto).toBe("ws_into");
    expect(from!.status).toBe("merged");
  });
  it("refuses to merge a workstream into itself", async () => {
    await storage.workstreams.create("team_local", { id: "ws_1", label: "Solo", scope: null });
    const r = await mergeWorkstreamsHandler(deps(), { from: "Solo", into: "Solo" });
    expect(r.isError).not.toBe(true);
    expect(r.content[0]!.text.toLowerCase()).toContain("same workstream");
    expect((await storage.workstreams.getById("team_local", "ws_1"))!.mergedInto).toBeNull();
  });
});

describe("rename_workstream + retire_workstream handlers", () => {
  it("renames a workstream resolved by id", async () => {
    await storage.workstreams.create("team_local", { id: "ws_1", label: "Old", scope: null });
    const r = await renameWorkstreamHandler(deps(), { idOrLabel: "ws_1", label: "New" });
    expect(r.isError).not.toBe(true);
    expect((await storage.workstreams.getById("team_local", "ws_1"))!.label).toBe("New");
  });

  it("renames a workstream resolved by label", async () => {
    await storage.workstreams.create("team_local", { id: "ws_1", label: "OldLabel", scope: null });
    const r = await renameWorkstreamHandler(deps(), { idOrLabel: "OldLabel", label: "NewLabel" });
    expect(r.isError).not.toBe(true);
    expect((await storage.workstreams.getById("team_local", "ws_1"))!.label).toBe("NewLabel");
  });

  it("refuses a rename that collides with a different workstream normalized label", async () => {
    await storage.workstreams.create("team_local", { id: "ws_1", label: "Alpha", scope: null });
    await storage.workstreams.create("team_local", { id: "ws_2", label: "Beta", scope: null });
    const r = await renameWorkstreamHandler(deps(), { idOrLabel: "ws_1", label: "  beta " });
    expect(r.isError).not.toBe(true);
    expect(r.content[0]!.text.toLowerCase()).toContain("already");
    expect((await storage.workstreams.getById("team_local", "ws_1"))!.label).toBe("Alpha");
  });

  it("allows a rename that normalizes to the same workstream (e.g. casing fix)", async () => {
    await storage.workstreams.create("team_local", { id: "ws_1", label: "alpha", scope: null });
    const r = await renameWorkstreamHandler(deps(), { idOrLabel: "ws_1", label: "Alpha" });
    expect(r.isError).not.toBe(true);
    expect((await storage.workstreams.getById("team_local", "ws_1"))!.label).toBe("Alpha");
  });

  it("returns a graceful message when the workstream is unknown", async () => {
    const r = await renameWorkstreamHandler(deps(), { idOrLabel: "nope", label: "Whatever" });
    expect(r.isError).not.toBe(true);
    expect(r.content[0]!.text.toLowerCase()).toContain("no workstream");
  });

  it("retires a workstream by label", async () => {
    await storage.workstreams.create("team_local", { id: "ws_1", label: "Dead", scope: null });
    const r = await retireWorkstreamHandler(deps(), { idOrLabel: "Dead" });
    expect(r.isError).not.toBe(true);
    expect((await storage.workstreams.getById("team_local", "ws_1"))!.status).toBe("retired");
  });

  it("returns a graceful message when retiring an unknown workstream", async () => {
    const r = await retireWorkstreamHandler(deps(), { idOrLabel: "ghost" });
    expect(r.isError).not.toBe(true);
    expect(r.content[0]!.text.toLowerCase()).toContain("no workstream");
  });
});

describe("list_merge_suggestions handler", () => {
  function seedEntities(...names: string[]) {
    const db = storage.sessions.rawDb();
    for (const n of names) {
      db.prepare("INSERT OR IGNORE INTO entities (canonical, type, status, source) VALUES (?, 'candidate', 'candidate', 'test')").run(n);
    }
  }

  it("suggests a near-duplicate active pair", async () => {
    seedEntities("alpha", "beta");
    await storage.workstreams.create("team_local", { id: "ws_a", label: "NLM", scope: null });
    await storage.workstreams.create("team_local", { id: "ws_b", label: "NLM Memory", scope: null });
    await storage.workstreams.upsertEntities("team_local", "ws_a", ["alpha", "beta"]);
    await storage.workstreams.upsertEntities("team_local", "ws_b", ["alpha", "beta"]);
    const r = await listMergeSuggestionsHandler(deps(), { minScore: 0.2 });
    expect(r.isError).not.toBe(true);
    expect(r.content[0]!.text).toContain("ws_a");
    expect(r.content[0]!.text).toContain("ws_b");
  });
});
