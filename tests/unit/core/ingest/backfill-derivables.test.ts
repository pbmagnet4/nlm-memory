/**
 * Unit tests for `backfillDerivables` (#352 phase-2, Task 3).
 *
 * Seeds a real SQLite store (migrations applied, tmp file) with a mix of
 * claude-code subagent rows, a claude-code top-level row, a hermes row, and
 * an already-stamped row, then asserts on selection + idempotency +
 * unknown-parent counting.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

    const report = await backfillDerivables(db);

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

    await backfillDerivables(db);
    const second = await backfillDerivables(db);

    expect(second.updated).toBe(0);
    expect(second.skippedAlreadyStamped).toBe(6);
    expect(second.total).toBe(6);
  });

  it("--dry-run reports counts without writing", async () => {
    await seed();
    const db = store.rawDb();

    const report = await backfillDerivables(db, { dryRun: true });
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

    await backfillDerivables(db);

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

    await backfillDerivables(db);

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

    const report = await backfillDerivables(db);
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

    const report = await backfillDerivables(db);
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

    const first = await backfillDerivables(db);
    expect(first.updated).toBe(1);
    expect(first.skippedNoop).toBe(0);

    const second = await backfillDerivables(db);
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

describe("backfillDerivables --with-transcript-scan (#352 phase-2, Task 5)", () => {
  let tmp: string;
  let storage: SqliteStorage;
  let store: SqliteSessionStore;
  const embedder = fakeEmbedder();

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-backfill-scan-"));
    storage = SqliteStorage.create({ dbPath: join(tmp, "test.sqlite"), migrationsDir: MIGRATIONS });
    await storage.init();
    store = storage.sessions;
  });

  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  function writeTranscript(lines: unknown[]): string {
    const path = join(tmp, `${lines.length}-${Math.random()}.jsonl`);
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    return path;
  }

  it("off by default: existing behavior scans no transcripts, columns stay NULL", async () => {
    const path = writeTranscript([
      { type: "assistant", message: { role: "assistant", model: "claude-opus-4-7", usage: { input_tokens: 10, output_tokens: 5 }, content: "hi" } },
    ]);
    await store.insertSession(
      baseRecord({ id: "s1", runtimeSessionId: "orch-1", transcriptPath: path }),
      embedder,
    );
    const db = store.rawDb();

    const report = await backfillDerivables(db);

    expect(report.transcriptScanned).toBe(0);
    const row = db
      .prepare<[string], { primary_model: string | null; total_tokens: number | null; skill: string | null }>(
        "SELECT primary_model, total_tokens, skill FROM sessions WHERE id = ?",
      )
      .get("s1");
    expect(row).toMatchObject({ primary_model: null, total_tokens: null, skill: null });
  });

  it("with the flag: stamps primary_model/total_tokens/skill from the transcript", async () => {
    const path = writeTranscript([
      { type: "assistant", message: { role: "assistant", model: "claude-opus-4-7", usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: "tool_use", name: "Skill", input: { skill: "code-review" } }] } },
    ]);
    await store.insertSession(
      baseRecord({ id: "s2", runtimeSessionId: "orch-2", transcriptPath: path }),
      embedder,
    );
    const db = store.rawDb();

    const report = await backfillDerivables(db, { withTranscriptScan: true });

    expect(report.transcriptScanned).toBe(1);
    const row = db
      .prepare<[string], { primary_model: string | null; total_tokens: number | null; skill: string | null }>(
        "SELECT primary_model, total_tokens, skill FROM sessions WHERE id = ?",
      )
      .get("s2");
    expect(row).toMatchObject({ primary_model: "claude-opus-4-7", total_tokens: 15, skill: "code-review" });
  });

  it("a persona-unrecoverable row can still pick up transcript columns and counts as updated", async () => {
    const path = writeTranscript([
      { type: "assistant", message: { role: "assistant", model: "claude-sonnet-4-5", usage: { input_tokens: 3, output_tokens: 2 }, content: "hi" } },
    ]);
    await store.insertSession(
      baseRecord({
        id: "s3",
        runtimeSessionId: "parent-1/agent-abc",
        label: "Classifier generated title, no subagent prefix",
        transcriptPath: path,
      }),
      embedder,
    );
    const db = store.rawDb();

    const report = await backfillDerivables(db, { withTranscriptScan: true });

    expect(report.updated).toBe(1);
    expect(report.skippedNoop).toBe(0);
    const row = db
      .prepare<[string], { agent_persona: string | null; primary_model: string | null }>(
        "SELECT agent_persona, primary_model FROM sessions WHERE id = ?",
      )
      .get("s3");
    expect(row).toMatchObject({ agent_persona: null, primary_model: "claude-sonnet-4-5" });
  });

  it("a row with no transcript_path is skipped for scanning without error", async () => {
    await store.insertSession(
      baseRecord({ id: "s4", runtimeSessionId: "orch-4", transcriptPath: null }),
      embedder,
    );
    const db = store.rawDb();

    const report = await backfillDerivables(db, { withTranscriptScan: true });

    expect(report.transcriptScanned).toBe(0);
    const row = db
      .prepare<[string], { primary_model: string | null }>("SELECT primary_model FROM sessions WHERE id = ?")
      .get("s4");
    expect(row).toMatchObject({ primary_model: null });
  });

  it("bug: persona-stamped rows were unreachable by --with-transcript-scan (flag shipped but effectively unwired for Task-3-processed rows)", async () => {
    const path = writeTranscript([
      { type: "assistant", message: { role: "assistant", model: "claude-opus-4-7", usage: { input_tokens: 40, output_tokens: 2 }, content: [{ type: "tool_use", name: "Skill", input: { skill: "session-close" } }] } },
    ]);
    // Already persona-stamped (as an earlier flagless Task 3 run would leave
    // it) but never transcript-scanned.
    await store.insertSession(
      baseRecord({
        id: "s_stamped",
        runtimeSessionId: "orch-6",
        agentPersona: "orchestrator",
        parentSessionId: null,
        transcriptPath: path,
      }),
      embedder,
    );
    const db = store.rawDb();
    const readRow = () =>
      db
        .prepare<[string], { agent_persona: string | null; primary_model: string | null; total_tokens: number | null; skill: string | null }>(
          "SELECT agent_persona, primary_model, total_tokens, skill FROM sessions WHERE id = ?",
        )
        .get("s_stamped");

    // Without the flag: not a candidate, untouched.
    const withoutFlag = await backfillDerivables(db);
    expect(withoutFlag.updated).toBe(0);
    expect(withoutFlag.transcriptScanned).toBe(0);
    expect(readRow()).toMatchObject({ agent_persona: "orchestrator", primary_model: null, total_tokens: null, skill: null });

    // With the flag: selected via the widened scan arm, scanned + updated.
    const withFlag = await backfillDerivables(db, { withTranscriptScan: true });
    expect(withFlag.updated).toBe(1);
    expect(withFlag.transcriptScanned).toBe(1);
    expect(readRow()).toMatchObject({
      agent_persona: "orchestrator",
      primary_model: "claude-opus-4-7",
      total_tokens: 42,
      skill: "session-close",
    });

    // With the flag again: scan columns now stamped, so the scan arm no
    // longer selects the row -- updated=0.
    const rerun = await backfillDerivables(db, { withTranscriptScan: true });
    expect(rerun.updated).toBe(0);
    expect(rerun.transcriptScanned).toBe(0);
  });

  it("bug: all-null scans (missing transcript) counted as updated forever - must be skippedNoop on every run with no UPDATE fired", async () => {
    // Scan-candidate row: persona already stamped, scan columns NULL,
    // transcript_path points at a file that does not exist.
    await store.insertSession(
      baseRecord({
        id: "s_missing",
        runtimeSessionId: "orch-7",
        agentPersona: "orchestrator",
        parentSessionId: null,
        transcriptPath: join(tmp, "rotated-away.jsonl"),
      }),
      embedder,
    );
    const db = store.rawDb();
    const totalChanges = () =>
      (db.prepare("SELECT total_changes() AS c").get() as { c: number }).c;

    const before1 = totalChanges();
    const run1 = await backfillDerivables(db, { withTranscriptScan: true });
    expect(run1.updated).toBe(0);
    expect(run1.skippedNoop).toBe(1);
    expect(run1.transcriptScanned).toBe(0);
    expect(totalChanges()).toBe(before1);

    const before2 = totalChanges();
    const run2 = await backfillDerivables(db, { withTranscriptScan: true });
    expect(run2.updated).toBe(0);
    expect(run2.skippedNoop).toBe(1);
    expect(run2.transcriptScanned).toBe(0);
    expect(totalChanges()).toBe(before2);
  });

  it("bug: persona-unrecoverable rows (persona NULL forever) re-scanned + re-counted as updated on every run after their scan columns were stamped", async () => {
    // The live T9 churn shape: a subagent row whose persona can never be
    // recovered stays selectable via the persona arm on every run. Run 1
    // legitimately stamps parent + scan columns; runs 2+ must be no-ops,
    // not repeat updated/transcript-scanned with byte-identical writes.
    const path = writeTranscript([
      { type: "assistant", message: { role: "assistant", model: "claude-opus-4-7", usage: { input_tokens: 10, output_tokens: 5 }, content: "hi" } },
    ]);
    await store.insertSession(
      baseRecord({
        id: "s_churn",
        runtime: "claude-code/1.0",
        runtimeSessionId: "parent-1/agent-abc",
        label: "Classifier generated title, no subagent prefix",
        transcriptPath: path,
      }),
      embedder,
    );
    const db = store.rawDb();

    const run1 = await backfillDerivables(db, { withTranscriptScan: true });
    expect(run1.updated).toBe(1);
    expect(run1.transcriptScanned).toBe(1);

    const run2 = await backfillDerivables(db, { withTranscriptScan: true });
    expect(run2.updated).toBe(0);
    expect(run2.skippedNoop).toBe(1);
    expect(run2.transcriptScanned).toBe(0);

    const row = db
      .prepare<[string], { agent_persona: string | null; parent_session_id: string | null; primary_model: string | null; total_tokens: number | null }>(
        "SELECT agent_persona, parent_session_id, primary_model, total_tokens FROM sessions WHERE id = ?",
      )
      .get("s_churn");
    expect(row).toMatchObject({
      agent_persona: null,
      parent_session_id: "parent-1",
      primary_model: "claude-opus-4-7",
      total_tokens: 15,
    });
  });

  it("is idempotent: a previously-stamped transcript column is preserved (COALESCE), not overwritten by a later degraded scan", async () => {
    const goodPath = writeTranscript([
      { type: "assistant", message: { role: "assistant", model: "claude-opus-4-7", usage: { input_tokens: 1, output_tokens: 1 }, content: "hi" } },
    ]);
    await store.insertSession(
      baseRecord({ id: "s5", runtimeSessionId: "orch-5", transcriptPath: goodPath }),
      embedder,
    );
    const db = store.rawDb();

    // First run scans successfully and stamps primary_model + agent_persona.
    await backfillDerivables(db, { withTranscriptScan: true });
    const afterFirst = db
      .prepare<[string], { agent_persona: string | null; primary_model: string | null }>(
        "SELECT agent_persona, primary_model FROM sessions WHERE id = ?",
      )
      .get("s5");
    expect(afterFirst).toMatchObject({ agent_persona: "orchestrator", primary_model: "claude-opus-4-7" });

    // Second run: agent_persona is now stamped, so the row is no longer a
    // candidate at all (selection unchanged) — the second pass is a true no-op.
    const second = await backfillDerivables(db, { withTranscriptScan: true });
    expect(second.transcriptScanned).toBe(0);
    const afterSecond = db
      .prepare<[string], { primary_model: string | null }>("SELECT primary_model FROM sessions WHERE id = ?")
      .get("s5");
    expect(afterSecond?.primary_model).toBe("claude-opus-4-7");
  });
});
