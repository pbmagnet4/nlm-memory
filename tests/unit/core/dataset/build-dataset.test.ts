import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildDataset } from "@core/dataset/build-dataset.js";

// Regression test for the 2026-10-01 GET /api/dataset outage: with 18,868
// sessions the unchunked session-id IN lists in projectFromDb exceeded
// SQLite's 32,766-variable cap (the edges query binds the list twice) and
// threw "too many SQL variables", failing the digest. 17,000 sessions trips
// the same failure on old code and passes on chunked queries.
const SESSION_COUNT = 17000;

const SCHEMA = `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  runtime TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration_min INTEGER,
  label TEXT NOT NULL,
  summary TEXT NOT NULL,
  status TEXT NOT NULL,
  transcript_path TEXT,
  tenant_id TEXT NOT NULL DEFAULT 'team_local'
);
CREATE TABLE session_entities (
  session_id TEXT NOT NULL,
  entity_canonical TEXT NOT NULL,
  PRIMARY KEY (session_id, entity_canonical)
);
CREATE TABLE markers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE session_edges (
  from_session TEXT NOT NULL,
  to_session TEXT NOT NULL,
  kind TEXT NOT NULL,
  PRIMARY KEY (from_session, to_session, kind)
);
CREATE TABLE entities (
  tenant_id TEXT NOT NULL,
  canonical TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  session_count INTEGER NOT NULL DEFAULT 0,
  last_seen_session TEXT,
  PRIMARY KEY (tenant_id, canonical)
);
`;

function sessionId(i: number): string {
  return `s-${String(i).padStart(5, "0")}`;
}

// Lexically ordered start times (ORDER BY started_at ASC must match index order).
function startedAt(i: number): string {
  const day = 1 + Math.floor(i / 1440);
  const hh = String(Math.floor((i % 1440) / 60)).padStart(2, "0");
  const mm = String(i % 60).padStart(2, "0");
  return `2026-01-${String(day).padStart(2, "0")}T${hh}:${mm}:00`;
}

describe("buildDataset with a corpus past the SQLite variable cap", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nlm-dataset-chunk-"));
    dbPath = join(dir, "corpus.sqlite");
    const db = new Database(dbPath);
    db.exec(SCHEMA);
    db.exec(`INSERT INTO entities (tenant_id, canonical, type, status, session_count)
             VALUES ('test', 'acme', 'org', 'active', ${SESSION_COUNT})`);
    const insertSession = db.prepare(
      `INSERT INTO sessions (id, runtime, started_at, label, summary, status, tenant_id)
       VALUES (?, 'test', ?, 'label', 'summary', 'closed', 'test')`,
    );
    const insertEntity = db.prepare(
      `INSERT INTO session_entities (session_id, entity_canonical) VALUES (?, 'acme')`,
    );
    const insertMany = db.transaction((count: number) => {
      for (let i = 0; i < count; i++) {
        insertSession.run(sessionId(i), startedAt(i));
        insertEntity.run(sessionId(i));
      }
    });
    insertMany(SESSION_COUNT);
    // Decision marker in the final chunk.
    db.prepare(
      `INSERT INTO markers (session_id, kind, text, position) VALUES (?, 'decision', 'ship it', 0)`,
    ).run(sessionId(16500));
    // Supersedes edge straddling a chunk boundary (chunks of 400).
    db.prepare(
      `INSERT INTO session_edges (from_session, to_session, kind) VALUES (?, ?, 'supersedes')`,
    ).run(sessionId(15999), sessionId(16000));
    db.close();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("projects every session with entities, decisions, and cross-chunk edges", () => {
    const dataset = buildDataset(dbPath, "test");
    expect(dataset.sessions).toHaveLength(SESSION_COUNT);
    const last = dataset.sessions[SESSION_COUNT - 1]!;
    expect(last.id).toBe(sessionId(SESSION_COUNT - 1));
    expect(last.entities).toContain("acme");
    const withDecision = dataset.sessions.find((s) => s.id === sessionId(16500))!;
    expect(withDecision.decisions).toContain("ship it");
    const edgeSource = dataset.sessions.find((s) => s.id === sessionId(15999))!;
    expect(edgeSource.supersedes).toBe(sessionId(16000));
  });
});
