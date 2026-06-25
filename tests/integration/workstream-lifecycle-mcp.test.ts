import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import { makeSession } from "../fixtures/sessions.js";
import { mergeWorkstreamsHandler, rebindSessionHandler, renameWorkstreamHandler, retireWorkstreamHandler } from "../../src/mcp/server.js";

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
    await storage.workstreams.create({ id: "ws_1", label: "NLM" });
    const r = await rebindSessionHandler(deps(), { sessionId: "s1", workstream: "NLM" });
    expect(r.isError).not.toBe(true);
    const ids = await storage.sessions.getWorkstreamIds(["s1"]);
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
    await storage.workstreams.create({ id: "ws_from", label: "Dup" });
    await storage.workstreams.create({ id: "ws_into", label: "Keep" });
    const r = await mergeWorkstreamsHandler(deps(), { from: "Dup", into: "Keep" });
    expect(r.isError).not.toBe(true);
    const from = await storage.workstreams.getById("ws_from");
    expect(from!.mergedInto).toBe("ws_into");
    expect(from!.status).toBe("merged");
  });
  it("refuses to merge a workstream into itself", async () => {
    await storage.workstreams.create({ id: "ws_1", label: "Solo" });
    const r = await mergeWorkstreamsHandler(deps(), { from: "Solo", into: "Solo" });
    expect(r.isError).not.toBe(true);
    expect(r.content[0]!.text.toLowerCase()).toContain("same workstream");
    expect((await storage.workstreams.getById("ws_1"))!.mergedInto).toBeNull();
  });
});

describe("rename_workstream + retire_workstream handlers", () => {
  it("renames a workstream resolved by id", async () => {
    await storage.workstreams.create({ id: "ws_1", label: "Old" });
    const r = await renameWorkstreamHandler(deps(), { idOrLabel: "ws_1", label: "New" });
    expect(r.isError).not.toBe(true);
    expect((await storage.workstreams.getById("ws_1"))!.label).toBe("New");
  });

  it("renames a workstream resolved by label", async () => {
    await storage.workstreams.create({ id: "ws_1", label: "OldLabel" });
    const r = await renameWorkstreamHandler(deps(), { idOrLabel: "OldLabel", label: "NewLabel" });
    expect(r.isError).not.toBe(true);
    expect((await storage.workstreams.getById("ws_1"))!.label).toBe("NewLabel");
  });

  it("refuses a rename that collides with a different workstream normalized label", async () => {
    await storage.workstreams.create({ id: "ws_1", label: "Alpha" });
    await storage.workstreams.create({ id: "ws_2", label: "Beta" });
    const r = await renameWorkstreamHandler(deps(), { idOrLabel: "ws_1", label: "  beta " });
    expect(r.isError).not.toBe(true);
    expect(r.content[0]!.text.toLowerCase()).toContain("already");
    expect((await storage.workstreams.getById("ws_1"))!.label).toBe("Alpha");
  });

  it("allows a rename that normalizes to the same workstream (e.g. casing fix)", async () => {
    await storage.workstreams.create({ id: "ws_1", label: "alpha" });
    const r = await renameWorkstreamHandler(deps(), { idOrLabel: "ws_1", label: "Alpha" });
    expect(r.isError).not.toBe(true);
    expect((await storage.workstreams.getById("ws_1"))!.label).toBe("Alpha");
  });

  it("returns a graceful message when the workstream is unknown", async () => {
    const r = await renameWorkstreamHandler(deps(), { idOrLabel: "nope", label: "Whatever" });
    expect(r.isError).not.toBe(true);
    expect(r.content[0]!.text.toLowerCase()).toContain("no workstream");
  });

  it("retires a workstream by label", async () => {
    await storage.workstreams.create({ id: "ws_1", label: "Dead" });
    const r = await retireWorkstreamHandler(deps(), { idOrLabel: "Dead" });
    expect(r.isError).not.toBe(true);
    expect((await storage.workstreams.getById("ws_1"))!.status).toBe("retired");
  });

  it("returns a graceful message when retiring an unknown workstream", async () => {
    const r = await retireWorkstreamHandler(deps(), { idOrLabel: "ghost" });
    expect(r.isError).not.toBe(true);
    expect(r.content[0]!.text.toLowerCase()).toContain("no workstream");
  });
});
