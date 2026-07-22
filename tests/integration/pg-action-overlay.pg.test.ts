/**
 * PG session reads apply the action overlay (Task 1, C-6).
 *
 * Verifies that resolve_open and promote_open actions written via
 * writeActionsBatchPg are reflected when sessions are read back through
 * PgSessionStore, and that retire_entity is deliberately NOT applied on the
 * recall path (strict parity with sqlite, where entity retirement is a UI
 * projection concern in build-dataset.ts).
 *
 * Requires NLM_PG_TEST_URL. Skips when absent.
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { PgStorage } from "../../src/core/storage/pg-storage.js";
import { writeActionsBatchPg, writeActionPg } from "../../src/core/actions/actions-log.js";
import { openQuestionId } from "../../src/core/actions/overlay.js";
import { makeSession } from "../fixtures/sessions.js";

const PG_TEST_URL = process.env["NLM_PG_TEST_URL"];
const MIGRATIONS_DIR = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../migrations/pg",
);

const TRUNCATE_SQL = `
  TRUNCATE TABLE
    session_chunk_map, session_embedding_chunks,
    session_entities, markers, session_edges,
    fact_embeddings, facts, sessions,
    entities, sources, providers, adapter_state, actions
  RESTART IDENTITY CASCADE
`;

describe.skipIf(!PG_TEST_URL)("pg session reads apply the action overlay", () => {
  let storage: PgStorage;
  let pool: Pool;

  beforeAll(async () => {
    storage = PgStorage.create({
      connectionString: PG_TEST_URL!,
      migrationsDir: MIGRATIONS_DIR,
    });
    await storage.init();
    pool = storage.pgPool();
  });

  afterAll(async () => {
    await storage.close();
  });

  beforeEach(async () => {
    await pool.query(TRUNCATE_SQL);
    storage.sessions.invalidateOverlayCache();
  });

  it("resolve_open action hides the open question from pg session reads", async () => {
    const openText = "Should we migrate to pg?";
    const session = makeSession({ id: "sess_overlay_1", open: [openText] });
    await storage.sessions.insertSessionForTest(session);

    const oqId = openQuestionId(session.id, openText);
    await writeActionsBatchPg(pool, "team_local", [
      { kind: "resolve_open", subjectType: "open_question", subjectId: oqId },
    ]);

    const [readBack] = await storage.sessions.getByIds("team_local", [session.id]);
    expect(readBack!.open).toHaveLength(0);
  });

  it("promote_open action moves the open question into decisions", async () => {
    const openText = "What database should we use?";
    const session = makeSession({ id: "sess_overlay_p", open: [openText] });
    await storage.sessions.insertSessionForTest(session);

    const oqId = openQuestionId(session.id, openText);
    await writeActionsBatchPg(pool, "team_local", [
      {
        kind: "promote_open",
        subjectType: "open_question",
        subjectId: oqId,
        payload: { resolution: "Use PostgreSQL" },
      },
    ]);

    const [readBack] = await storage.sessions.getByIds("team_local", [session.id]);
    expect(readBack!.open).toHaveLength(0);
    expect(readBack!.decisions).toContain("Use PostgreSQL");
  });

  it("retire_entity does not affect recall reads (parity with sqlite; UI projection handles retirement)", async () => {
    const entity = "SampleVenture";
    const session = makeSession({ id: "sess_overlay_2", entities: [entity] });
    await storage.sessions.insertSessionForTest(session);

    await writeActionsBatchPg(pool, "team_local", [
      { kind: "retire_entity", subjectType: "entity", subjectId: entity },
    ]);

    const [readBack] = await storage.sessions.getByIds("team_local", [session.id]);
    expect(readBack!.entities).toEqual([entity]);
  });

  it("sessions read identically with an empty actions table", async () => {
    const session = makeSession({
      id: "sess_overlay_3",
      open: ["Is this working?"],
      entities: ["NLM"],
    });
    await storage.sessions.insertSessionForTest(session);

    const [readBack] = await storage.sessions.getByIds("team_local", [session.id]);
    expect(readBack!.open).toEqual(["Is this working?"]);
    expect(readBack!.entities).toEqual(["NLM"]);
  });

  it("pg overlay cache: a write without invalidation stays hidden until invalidateOverlayCache is called", async () => {
    const openText = "Cache liveness check?";
    const session = makeSession({ id: "sess_pg_cache_live", open: [openText] });
    await storage.sessions.insertSessionForTest(session);

    await storage.sessions.getByIds("team_local", [session.id]); // populate cache
    const oqId = openQuestionId(session.id, openText);
    await writeActionPg(pool, "team_local", { kind: "resolve_open", subjectType: "open_question", subjectId: oqId });
    const stale = await storage.sessions.getByIds("team_local", [session.id]);
    expect(stale[0]?.open?.some((q) => q === openText)).toBe(true); // cache still active
    storage.sessions.invalidateOverlayCache();
    const fresh = await storage.sessions.getByIds("team_local", [session.id]);
    expect(fresh[0]?.open?.some((q) => q === openText)).toBe(false);
  });

  describe("rowToSession computes live status (Task 7)", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "nlm-live-status-"));
    });

    afterAll(() => {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });

    it("reads status as active when transcript_path points at a recently modified file", async () => {
      const transcriptPath = join(tmpDir, "session.jsonl");
      writeFileSync(transcriptPath, "");
      const session = makeSession({
        id: "sess_live_status",
        status: "closed",
        transcriptPath,
      });
      await storage.sessions.insertSessionForTest(session);
      const [readBack] = await storage.sessions.getByIds("team_local", [session.id]);
      expect(readBack!.status).toBe("active");
    });

    it("reads status as closed when transcript_path is null", async () => {
      const session = makeSession({ id: "sess_live_null_path", status: "closed", transcriptPath: null });
      await storage.sessions.insertSessionForTest(session);
      const [readBack] = await storage.sessions.getByIds("team_local", [session.id]);
      expect(readBack!.status).toBe("closed");
    });
  });
});
