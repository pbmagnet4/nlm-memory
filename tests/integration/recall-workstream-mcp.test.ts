// tests/integration/recall-workstream-mcp.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import { recallWorkstreamHandler } from "../../src/mcp/server.js";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");
let storage: SqliteStorage; let tmp: string;
beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "nlm-rws-"));
  storage = SqliteStorage.create({ dbPath: join(tmp, "canonical.sqlite"), migrationsDir: MIGRATIONS_DIR });
  await storage.init();
});
afterEach(async () => { await storage.close(); rmSync(tmp, { recursive: true, force: true }); });

function deps() {
  return {
    recall: {} as any, store: storage.sessions,
    workstreams: { store: storage.workstreams, sessions: storage.sessions, facts: storage.facts, exemplars: storage.exemplars },
  } as any;
}

describe("recall_workstream handler", () => {
  it("resolves by label and returns the rolled-up view", async () => {
    await storage.workstreams.create({ id: "ws_1", label: "NLM" });
    const r = await recallWorkstreamHandler(deps(), { idOrLabel: "NLM" });
    expect(r.isError).not.toBe(true);
    expect(r.content[0]!.text).toContain("NLM");
  });
  it("returns a graceful not-found message for an unknown workstream", async () => {
    const r = await recallWorkstreamHandler(deps(), { idOrLabel: "Nonexistent" });
    expect(r.isError).not.toBe(true);
    expect(r.content[0]!.text.toLowerCase()).toContain("no workstream");
  });
  it("returns an unavailable message when workstreams deps are not wired", async () => {
    const r = await recallWorkstreamHandler({ recall: {}, store: storage.sessions } as any, { idOrLabel: "NLM" });
    expect(r.content[0]!.text.toLowerCase()).toContain("not available");
  });
});
