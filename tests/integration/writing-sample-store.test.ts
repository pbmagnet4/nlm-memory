/**
 * SqliteStorage adapter — WritingSampleStore contract (T2438 piece A).
 *
 * The storage under test is built with a pinned install scope so the
 * server-side stamping is assertable without touching ~/.nlm/install-id.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runWritingSampleStoreContract } from "../contract/writing-sample-store.contract.js";
import type { WritingSampleStoreContractHarness } from "../contract/writing-sample-store.contract.js";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import { SqliteWritingSampleStore } from "../../src/core/storage/sqlite-writing-sample-store.js";
import { runMigrations } from "../../src/core/storage/migrate.js";
import type { Storage } from "../../src/ports/storage.js";
import type { WritingSampleOutcome } from "../../src/ports/writing-sample-store.js";

const MIGRATIONS_DIR = resolve("migrations");
const INSTALL_SCOPE = "install-contract-test";
const dirs = new WeakMap<Storage, string>();

async function createStorage(): Promise<SqliteStorage> {
  const dir = mkdtempSync(join(tmpdir(), "nlm-writing-sample-"));
  const storage = SqliteStorage.create({
    dbPath: join(dir, "corpus.sqlite"),
    migrationsDir: MIGRATIONS_DIR,
    installScopeProvider: () => INSTALL_SCOPE,
  });
  dirs.set(storage, dir);
  return storage;
}

const harness: WritingSampleStoreContractHarness = {
  name: "SqliteStorage",
  installScope: INSTALL_SCOPE,
  setup: createStorage,
  async teardown(storage) {
    await storage.close();
    rmSync(dirs.get(storage)!, { recursive: true, force: true });
  },
  async ensureTeam(storage, teamId) {
    (storage as SqliteStorage).rawDb().prepare("INSERT OR IGNORE INTO teams (id, name) VALUES (?, ?)").run(teamId, teamId);
  },
  async rawSample(storage, id) {
    return (storage as SqliteStorage).rawDb()
      .prepare<[string], { install_scope: string; text_hash: string; tenant_id: string }>(
        "SELECT install_scope, text_hash, tenant_id FROM writing_samples WHERE id = ?",
      )
      .get(id) ?? null;
  },
  async hasVector(storage, id) {
    return (
      (storage as SqliteStorage).rawDb()
        .prepare<[string], { one: number }>("SELECT 1 AS one FROM writing_samples_vec WHERE sample_id = ?")
        .get(id) !== undefined
    );
  },
};

describe("SqliteStorage: writing-sample-store contract", () => {
  runWritingSampleStoreContract(harness);
});

describe("SqliteWritingSampleStore: the vector read leaves the main connection", () => {
  it("dispatches search to the semantic read worker lane", async () => {
    const storage = await createStorage();
    try {
      const { id } = await storage.writingSamples.insert("team_local", {
        voice: "edward",
        channel: "linkedin",
        source: "published",
        outcome: "published",
        text: "a published post",
        ts: "2026-11-20T09:00:00.000Z",
      });
      await storage.writingSamples.upsertEmbedding("team_local", id, new Float32Array(768));
      const reader = storage.sessions.semanticReader!;
      const read = vi.spyOn(reader, "read");
      const hits = await storage.writingSamples.search("team_local", new Float32Array(768), {
        voice: "edward",
        outcomes: ["published"],
        k: 3,
      });
      expect(hits.map((hit) => hit.id)).toEqual([id]);
      expect(read).toHaveBeenCalledOnce();
      expect(read.mock.calls[0]![0]).toEqual(expect.objectContaining({ lane: "writing-samples", limit: 3 }));
      // The scope is resolved by the store, never by the caller.
      expect(read.mock.calls[0]![0].options).toEqual(expect.objectContaining({ installScope: INSTALL_SCOPE }));
    } finally {
      await storage.close();
      rmSync(dirs.get(storage)!, { recursive: true, force: true });
    }
  });

  it("answers the same query inline when the store has no reader", async () => {
    const storage = await createStorage();
    try {
      const seed = async (text: string, distance: number, outcome: WritingSampleOutcome) => {
        const { id } = await storage.writingSamples.insert("team_local", {
          voice: "edward",
          channel: "linkedin",
          source: outcome === "published" ? "published" : "approved",
          outcome,
          text,
          ts: "2026-11-20T09:00:00.000Z",
        });
        const vector = new Float32Array(768);
        vector[0] = distance;
        await storage.writingSamples.upsertEmbedding("team_local", id, vector);
        return id;
      };
      const near = await seed("the near one", 1, "published");
      const far = await seed("the far one", 3, "published");
      const rejected = await seed("one I threw away", 0.5, "rejected");
      await storage.writingSamples.insert("team_local", {
        voice: "edward",
        channel: "linkedin",
        source: "approved",
        outcome: "published",
        text: "no vector at all",
        ts: "2026-11-19T09:00:00.000Z",
      });

      const inline = new SqliteWritingSampleStore(storage.rawDb(), undefined, {
        installScopeProvider: () => INSTALL_SCOPE,
      });
      const filter = { voice: "edward", channel: "linkedin", outcomes: ["published", "approved"] as const, k: 5 };
      const viaWorker = await storage.writingSamples.search("team_local", new Float32Array(768), filter);
      const viaInline = await inline.search("team_local", new Float32Array(768), filter);

      expect(viaWorker.map((hit) => hit.id)).toEqual([near, far]);
      expect(viaInline).toEqual(viaWorker);
      expect(viaInline.map((hit) => hit.id)).not.toContain(rejected);
      expect((await inline.search("team_local", new Float32Array(768), { ...filter, k: 1 })).map((hit) => hit.id)).toEqual([near]);
      expect(await inline.search("team_local", new Float32Array(768), { ...filter, channel: "email", outcomes: ["published"] as const })).toEqual([]);
      expect((await inline.missingEmbeddings("team_local", 10)).length).toBe(1);
    } finally {
      await storage.close();
      rmSync(dirs.get(storage)!, { recursive: true, force: true });
    }
  });

  it("answers exactly once the corpus passes the native KNN cap", async () => {
    const storage = await createStorage();
    try {
      storage.rawDb().prepare("INSERT OR IGNORE INTO teams (id, name) VALUES ('team_foreign', 'Foreign')").run();
      const put = async (tenant: string, text: string, distance: number) => {
        const { id } = await storage.writingSamples.insert(tenant, {
          voice: "edward",
          channel: "linkedin",
          source: "published",
          outcome: "published",
          text,
          ts: "2026-11-20T09:00:00.000Z",
        });
        const vector = new Float32Array(768);
        vector[0] = distance;
        await storage.writingSamples.upsertEmbedding(tenant, id, vector);
        return id;
      };
      const near = await put("team_local", "my near post", 1);
      const far = await put("team_local", "my far post", 2);
      // Past the 4096-neighbor ceiling the KNN window can never reach this
      // tenant's own rows, so the read switches to the exact scan — the same
      // shape as the scoped-semantic-recall cap test (T1770).
      for (let i = 0; i < 4100; i++) await put("team_foreign", `foreign post ${i}`, 0.01);

      const hits = await storage.writingSamples.search("team_local", new Float32Array(768), {
        voice: "edward",
        outcomes: ["published", "approved"],
        k: 2,
      });
      expect(hits.map((hit) => hit.id)).toEqual([near, far]);
    } finally {
      await storage.close();
      rmSync(dirs.get(storage)!, { recursive: true, force: true });
    }
  }, 60_000);
});

it("registers migration 51 and re-applying the set is a no-op", async () => {
  const storage = await createStorage();
  try {
    const db = storage.rawDb();
    const row = db
      .prepare<[], { version: number; name: string }>("SELECT version, name FROM schema_migrations WHERE version = 51")
      .get();
    expect(row).toMatchObject({ version: 51, name: "051_writing_samples" });
    expect(db.prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE name IN ('writing_samples','writing_samples_vec')").all().map((r) => r.name).sort())
      .toEqual(["writing_samples", "writing_samples_vec"]);
    expect(runMigrations(db, MIGRATIONS_DIR)).toEqual([]);
  } finally {
    await storage.close();
    rmSync(dirs.get(storage)!, { recursive: true, force: true });
  }
});
