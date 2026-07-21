/**
 * Unit tests for `backfillDerivables` (#352 phase-2, Task 3).
 *
 * Seeds a real SQLite store (migrations applied, tmp file) with a mix of
 * claude-code subagent rows, a claude-code top-level row, a hermes row, and
 * an already-stamped row, then asserts on selection + idempotency +
 * unknown-parent counting.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../../../../src/core/storage/sqlite-storage.js";
import type { IngestRecord, SqliteSessionStore } from "../../../../src/core/storage/sqlite-session-store.js";
import type { EmbedResult, LLMClient } from "../../../../src/ports/llm-client.js";
import { backfillDerivables } from "../../../../src/core/ingest/backfill-derivables.js";

const MIGRATIONS = resolve(process.cwd(), "migrations");

function fakeEmbedder(): LLMClient {
  return {
    classify: async () => { throw new Error("stub"); },
    embed: async (): Promise<EmbedResult> => ({ vector: new Float32Array(768), model: "test" }),
    rewriteForRecall: async () => { throw new Error("stub"); },
    nameWorkstream: async () => { throw new Error("stub"); },
  } as LLMClient;
}

function baseRecord(over: Partial<IngestRecord> & { id: string }): IngestRecord {
  return {
    runtime: "claude-code",
    runtimeSessionId: over.id,
    startedAt: "2026-01-01T10:00:00Z",
    endedAt: "2026-01-01T10:30:00Z",
    durationMin: 30,
    label: "Some label",
    summary: "Some summary",
    body: "body text",
    status: "closed",
    transcriptKind: "claude-code-jsonl",
    transcriptPath: null,
    transcriptOffset: null,
    transcriptLength: null,
    entities: [],
    decisions: [],
    openQuestions: [],
    scope: null,
    ...over,
  };
}

describe("backfillDerivables", () => {
  let tmp: string;
  let storage: SqliteStorage;
  let store: SqliteSessionStore;
  const embedder = fakeEmbedder();

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-backfill-"));
    storage = SqliteStorage.create({ dbPath: join(tmp, "test.sqlite"), migrationsDir: MIGRATIONS });
    await storage.init();
    store = storage.sessions;
  });

  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  async function seed(): Promise<void> {
    // 3 claude-code subagent rows (two with a resolvable parent, one whose
    // parent is the literal "unknown" placeholder quirk from Task 2 review
    // — all three still derive a non-null persona).
    await store.insertSession(
      baseRecord({
        id: "sub_ok",
        runtimeSessionId: "orch-1/agent-abc",
        label: "[subagent Web Developer] did stuff",
      }),
      embedder,
    );
    await store.insertSession(
      baseRecord({
        id: "sub_unknown",
        runtimeSessionId: "unknown/agent-def",
        label: "[subagent Growth Strategist] did stuff",
      }),
      embedder,
    );
    await store.insertSession(
      baseRecord({
        id: "sub_ok2",
        runtimeSessionId: "orch-2/agent-ghi",
        label: "[subagent Content Director] did stuff",
      }),
      embedder,
    );
    // 2 top-level claude-code rows (no slash in runtimeSessionId).
    await store.insertSession(baseRecord({ id: "top_1", runtimeSessionId: "orch-1" }), embedder);
    await store.insertSession(baseRecord({ id: "top_2", runtimeSessionId: "orch-2" }), embedder);
    // 1 already-stamped row (simulates a freshly-ingested row post-34968a8).
    await store.insertSession(
      baseRecord({
        id: "already_stamped",
        runtime: "hermes",
        runtimeSessionId: "hermes-1",
        agentPersona: "hermes",
        parentSessionId: null,
      }),
      embedder,
    );
  }

  it("stamps NULL rows and leaves already-stamped rows alone", async () => {
    await seed();
    const db = store.rawDb();

    const report = backfillDerivables(db);

    expect(report.total).toBe(6);
    expect(report.updated).toBe(5);
    expect(report.skippedAlreadyStamped).toBe(1);
    expect(report.subagentCandidates).toBe(3);
    expect(report.unknownParent).toBe(1);

    const rows = db
      .prepare<[], { id: string; agent_persona: string | null; parent_session_id: string | null }>(
        "SELECT id, agent_persona, parent_session_id FROM sessions ORDER BY id",
      )
      .all();
    const byId = new Map(rows.map((r) => [r.id, r]));

    expect(byId.get("sub_ok")).toMatchObject({ agent_persona: "Web Developer", parent_session_id: "orch-1" });
    expect(byId.get("sub_unknown")).toMatchObject({ agent_persona: "Growth Strategist", parent_session_id: "unknown" });
    expect(byId.get("sub_ok2")).toMatchObject({ agent_persona: "Content Director", parent_session_id: "orch-2" });
    expect(byId.get("top_1")).toMatchObject({ agent_persona: "orchestrator", parent_session_id: null });
    expect(byId.get("top_2")).toMatchObject({ agent_persona: "orchestrator", parent_session_id: null });
    expect(byId.get("already_stamped")).toMatchObject({ agent_persona: "hermes", parent_session_id: null });

    // Inertness: personas are not all uniform (would indicate a stamping bug
    // that collapses every row to one value).
    const personas = new Set(rows.map((r) => r.agent_persona));
    expect(personas.size).toBeGreaterThan(1);
  });

  it("is idempotent: a second run updates nothing", async () => {
    await seed();
    const db = store.rawDb();

    backfillDerivables(db);
    const second = backfillDerivables(db);

    expect(second.updated).toBe(0);
    expect(second.skippedAlreadyStamped).toBe(6);
    expect(second.total).toBe(6);
  });

  it("--dry-run reports counts without writing", async () => {
    await seed();
    const db = store.rawDb();

    const report = backfillDerivables(db, { dryRun: true });
    expect(report.updated).toBe(5);
    expect(report.unknownParent).toBe(1);

    const row = db
      .prepare<[string], { agent_persona: string | null }>("SELECT agent_persona FROM sessions WHERE id = ?")
      .get("sub_ok");
    expect(row?.agent_persona).toBeNull();
  });

  it("gives a hermes row persona = runtime name, parent null", async () => {
    await store.insertSession(baseRecord({ id: "herm_1", runtime: "hermes", runtimeSessionId: "h-1" }), embedder);
    const db = store.rawDb();

    backfillDerivables(db);

    const row = db
      .prepare<[string], { agent_persona: string | null; parent_session_id: string | null }>(
        "SELECT agent_persona, parent_session_id FROM sessions WHERE id = ?",
      )
      .get("herm_1");
    expect(row).toMatchObject({ agent_persona: "hermes", parent_session_id: null });
  });

  it("strips the runtime version suffix before branching (runtime column is versioned in production, e.g. claude-code/1.0)", async () => {
    await store.insertSession(
      baseRecord({
        id: "sub_versioned",
        runtime: "claude-code/1.0",
        runtimeSessionId: "orch-3/agent-xyz",
        label: "[subagent Systems Engineer] did stuff",
      }),
      embedder,
    );
    await store.insertSession(baseRecord({ id: "herm_versioned", runtime: "hermes/1.0", runtimeSessionId: "h-2" }), embedder);
    const db = store.rawDb();

    backfillDerivables(db);

    const rows = db
      .prepare<[], { id: string; agent_persona: string | null; parent_session_id: string | null }>(
        "SELECT id, agent_persona, parent_session_id FROM sessions ORDER BY id",
      )
      .all();
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get("sub_versioned")).toMatchObject({ agent_persona: "Systems Engineer", parent_session_id: "orch-3" });
    expect(byId.get("herm_versioned")).toMatchObject({ agent_persona: "hermes", parent_session_id: null });
  });

  it("a malformed subagent-shaped id (slash but no /agent- suffix) derives nulls and is counted as no-op, not updated", async () => {
    await store.insertSession(
      baseRecord({ id: "sub_malformed", runtimeSessionId: "orch-1/weird-shape", label: "no subagent prefix here" }),
      embedder,
    );
    const db = store.rawDb();

    const report = backfillDerivables(db);
    expect(report.updated).toBe(0);
    expect(report.skippedNoop).toBe(1);

    const row = db
      .prepare<[string], { agent_persona: string | null; parent_session_id: string | null }>(
        "SELECT agent_persona, parent_session_id FROM sessions WHERE id = ?",
      )
      .get("sub_malformed");
    expect(row).toMatchObject({ agent_persona: null, parent_session_id: null });
  });

  it("stamps parent but not persona for the dominant production case: subagent-shaped id with an unprefixed classifier label", async () => {
    // Real corpus rows never carry the "[subagent <slug>]" prefix — the
    // classifier's generated title replaced chunk.label before the row
    // landed in sessions. Parent is still derivable from the id; persona
    // is genuinely lost.
    await store.insertSession(
      baseRecord({
        id: "sub_prod",
        runtime: "claude-code/1.0",
        runtimeSessionId: "parent-1/agent-abc",
        label: "Directory exploration blocked by permissions",
      }),
      embedder,
    );
    const db = store.rawDb();

    const report = backfillDerivables(db);
    expect(report.updated).toBe(1);
    expect(report.subagentCandidates).toBe(1);

    const row = db
      .prepare<[string], { agent_persona: string | null; parent_session_id: string | null }>(
        "SELECT agent_persona, parent_session_id FROM sessions WHERE id = ?",
      )
      .get("sub_prod");
    expect(row).toMatchObject({ agent_persona: null, parent_session_id: "parent-1" });
  });

  it("re-run over unrecoverable-persona rows reports updated=0 (bug: WHERE agent_persona IS NULL re-counted them as updated forever)", async () => {
    await store.insertSession(
      baseRecord({
        id: "sub_unrecoverable",
        runtime: "claude-code/1.0",
        runtimeSessionId: "parent-1/agent-abc",
        label: "Classifier generated title, no subagent prefix",
      }),
      embedder,
    );
    const db = store.rawDb();

    const first = backfillDerivables(db);
    expect(first.updated).toBe(1);
    expect(first.skippedNoop).toBe(0);

    const second = backfillDerivables(db);
    expect(second.updated).toBe(0);
    expect(second.skippedNoop).toBe(1);
    expect(second.skippedAlreadyStamped).toBe(0);
    expect(second.total).toBe(1);

    // The row itself is unchanged by the second run.
    const row = db
      .prepare<[string], { agent_persona: string | null; parent_session_id: string | null }>(
        "SELECT agent_persona, parent_session_id FROM sessions WHERE id = ?",
      )
      .get("sub_unrecoverable");
    expect(row).toMatchObject({ agent_persona: null, parent_session_id: "parent-1" });
  });
});
