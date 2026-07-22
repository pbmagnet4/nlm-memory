/**
 * PgStorage adapter — CodeExemplarStore contract + a pgvector search smoke test.
 *
 * Requires a running PostgreSQL+pgvector instance. Set NLM_PG_TEST_URL, e.g.:
 *   docker run --rm -p 55432:5432 -e POSTGRES_PASSWORD=test pgvector/pgvector:pg16
 *   NLM_PG_TEST_URL="postgres://postgres:test@localhost:55432/postgres" npm test
 *
 * Skips when the env var is absent (so CI stays green without a PG container).
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCodeExemplarStoreContract } from "../../tests/contract/code-exemplar-store.contract.js";
import type { CodeExemplarStoreContractHarness } from "../../tests/contract/code-exemplar-store.contract.js";
import { PgStorage } from "../../src/core/storage/pg-storage.js";
import type { Storage } from "../../src/ports/storage.js";
import type { CodeExemplarInput } from "../../src/shared/types.js";
import { codeHash } from "../../src/core/exemplars/ingest-exemplar.js";
import { usePgTestSchema } from "../helpers/pg-test-schema.js";

const PG_TEST_URL = process.env["NLM_PG_TEST_URL"];
const MIGRATIONS_DIR = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../migrations/pg",
);
const pgUrl = usePgTestSchema(PG_TEST_URL, import.meta.url);

const TRUNCATE_SQL =
  "TRUNCATE TABLE code_exemplar_embeddings, code_exemplars RESTART IDENTITY CASCADE";

async function freshStorage(): Promise<PgStorage> {
  const storage = PgStorage.create({
    connectionString: pgUrl(),
    migrationsDir: MIGRATIONS_DIR,
  });
  await storage.init();
  await storage.pgPool().query(TRUNCATE_SQL);
  return storage;
}

const harness: CodeExemplarStoreContractHarness = {
  name: "PgStorage",
  async setup(): Promise<Storage> {
    return freshStorage();
  },
  async teardown(storage: Storage): Promise<void> {
    await storage.close();
  },
};

describe.skipIf(!PG_TEST_URL)("PgStorage: code-exemplar-store contract", () => {
  runCodeExemplarStoreContract(harness);
});

/** Unit vector with a 1 at index i (768-dim) — mimics an L2-normalised embedding. */
function unitVec(i: number): Float32Array {
  const v = new Float32Array(768);
  v[i] = 1;
  return v;
}

function exemplar(over: Partial<CodeExemplarInput> & { code: string }): CodeExemplarInput {
  return {
    installScope: "install-test",
    signalId: null,
    sessionId: null,
    repo: "/repo/alpha",
    model: "qwen3-coder",
    lang: "ts",
    taskContext: "task",
    outcome: "pass",
    gitSha: null,
    survived: null,
    scope: null,
    ts: "2026-06-15T12:00:00.000Z",
    ...over,
    codeHash: codeHash(over.code),
  };
}

describe.skipIf(!PG_TEST_URL)("PgCodeExemplarStore.searchByVector (pgvector)", () => {
  let storage: PgStorage;
  beforeEach(async () => { storage = await freshStorage(); });
  afterEach(async () => { await storage.close(); });

  it("ranks the nearest embedding first", async () => {
    const a = await storage.exemplars.insert("team_local", exemplar({ code: "const a = 1;" }));
    const b = await storage.exemplars.insert("team_local", exemplar({ code: "const b = 2;" }));
    await storage.exemplars.upsertEmbedding("team_local", a.id, unitVec(0));
    await storage.exemplars.upsertEmbedding("team_local", b.id, unitVec(1));

    const hits = await storage.exemplars.searchByVector("team_local", unitVec(0), {
      installScope: "install-test",
      k: 2,
    });
    expect(hits).toHaveLength(2);
    expect(hits[0]!.id).toBe(a.id);
  });

  it("excludes negatives when includeNegatives is false", async () => {
    const fail = await storage.exemplars.insert("team_local", exemplar({ code: "const c = 3;", outcome: "fail" }));
    await storage.exemplars.upsertEmbedding("team_local", fail.id, unitVec(0));

    const withNeg = await storage.exemplars.searchByVector("team_local", unitVec(0), {
      installScope: "install-test",
      includeNegatives: true,
    });
    expect(withNeg.map((h) => h.id)).toContain(fail.id);

    const withoutNeg = await storage.exemplars.searchByVector("team_local", unitVec(0), {
      installScope: "install-test",
      includeNegatives: false,
    });
    expect(withoutNeg.map((h) => h.id)).not.toContain(fail.id);
  });
});
