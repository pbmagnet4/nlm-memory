import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import {
  computeCorpusStats,
  parseCorpusThresholds,
  sqliteCorpusStatsDeps,
  thresholdState,
  type CorpusStatsDeps,
} from "@core/metrics/corpus-stats.js";

const MINIMAL_SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  runtime TEXT NOT NULL DEFAULT 'test',
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  label TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  body TEXT,
  status TEXT NOT NULL DEFAULT 'closed'
);

CREATE TABLE IF NOT EXISTS entities (
  canonical TEXT PRIMARY KEY,
  type TEXT NOT NULL DEFAULT 'candidate',
  status TEXT NOT NULL DEFAULT 'candidate',
  session_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS session_entities (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  entity_canonical TEXT NOT NULL REFERENCES entities(canonical),
  PRIMARY KEY (session_id, entity_canonical)
);

CREATE TABLE IF NOT EXISTS markers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  kind TEXT NOT NULL DEFAULT 'decision',
  text TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS facts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'decision',
  subject TEXT NOT NULL DEFAULT '',
  predicate TEXT NOT NULL DEFAULT '',
  value TEXT NOT NULL DEFAULT '',
  source_session_id TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  superseded_by TEXT REFERENCES facts(id),
  retired_at TEXT
);

CREATE TABLE IF NOT EXISTS code_exemplars (
  id TEXT PRIMARY KEY,
  install_scope TEXT NOT NULL DEFAULT 'test',
  repo TEXT NOT NULL DEFAULT 'testrepo',
  model TEXT NOT NULL DEFAULT 'test-model',
  task_context TEXT NOT NULL DEFAULT '',
  code TEXT NOT NULL DEFAULT '',
  code_hash TEXT NOT NULL DEFAULT '',
  outcome TEXT NOT NULL DEFAULT 'pass',
  survived INTEGER,
  ts TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(MINIMAL_SCHEMA);
  return db;
}

describe("sqliteCorpusStatsDeps + computeCorpusStats", () => {
  let tmp: string;
  let dbPath: string;
  let db: Database.Database;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-corpus-stats-"));
    dbPath = join(tmp, "canonical.sqlite");
    writeFileSync(dbPath, "");
    db = new Database(dbPath);
    db.exec(MINIMAL_SCHEMA);
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns zeros on an empty database", async () => {
    const deps = sqliteCorpusStatsDeps(db, dbPath);
    const stats = await computeCorpusStats(deps);
    expect(stats.sessions).toBe(0);
    expect(stats.bodyBytes).toBe(0);
    expect(stats.cappedBodies).toBe(0);
    expect(stats.entities).toBe(0);
    expect(stats.hapaxEntities).toBe(0);
    expect(stats.factsActive).toBe(0);
    expect(stats.factsSuperseded).toBe(0);
    expect(stats.factsRetired).toBe(0);
    expect(stats.markers).toBe(0);
    expect(stats.exemplars).toBe(0);
  });

  it("counts sessions correctly", async () => {
    db.exec(`
      INSERT INTO sessions (id, label, summary) VALUES ('s1', 'a', '');
      INSERT INTO sessions (id, label, summary) VALUES ('s2', 'b', '');
    `);
    const stats = await computeCorpusStats(sqliteCorpusStatsDeps(db, dbPath));
    expect(stats.sessions).toBe(2);
  });

  it("sums body bytes and counts capped bodies", async () => {
    const smallBody = "x".repeat(100);
    const cappedBody = "y".repeat(200000);
    db.exec(`
      INSERT INTO sessions (id, label, summary, body) VALUES ('s1', '', '', '${smallBody}');
      INSERT INTO sessions (id, label, summary, body) VALUES ('s2', '', '', '${cappedBody}');
      INSERT INTO sessions (id, label, summary, body) VALUES ('s3', '', '', NULL);
    `);
    const stats = await computeCorpusStats(sqliteCorpusStatsDeps(db, dbPath));
    expect(stats.bodyBytes).toBe(100 + 200000);
    expect(stats.cappedBodies).toBe(1);
  });

  it("counts entities and hapax entities (session_count = 1)", async () => {
    db.exec(`
      INSERT INTO entities (canonical, session_count) VALUES ('qdrant', 1);
      INSERT INTO entities (canonical, session_count) VALUES ('pgvector', 3);
      INSERT INTO entities (canonical, session_count) VALUES ('redis', 1);
    `);
    const stats = await computeCorpusStats(sqliteCorpusStatsDeps(db, dbPath));
    expect(stats.entities).toBe(3);
    expect(stats.hapaxEntities).toBe(2);
  });

  it("splits facts into active, superseded, and retired", async () => {
    db.exec(`
      INSERT INTO sessions (id, label, summary) VALUES ('s1', '', '');
      INSERT INTO facts (id, source_session_id, superseded_by, retired_at) VALUES ('f1', 's1', NULL, NULL);
      INSERT INTO facts (id, source_session_id, superseded_by, retired_at) VALUES ('f2', 's1', NULL, NULL);
      INSERT INTO facts (id, source_session_id, superseded_by, retired_at) VALUES ('f3', 's1', 'f1', NULL);
      INSERT INTO facts (id, source_session_id, superseded_by, retired_at) VALUES ('f4', 's1', NULL, '2026-01-01');
    `);
    const stats = await computeCorpusStats(sqliteCorpusStatsDeps(db, dbPath));
    expect(stats.factsActive).toBe(2);
    expect(stats.factsSuperseded).toBe(1);
    expect(stats.factsRetired).toBe(1);
  });

  it("counts markers", async () => {
    db.exec(`
      INSERT INTO sessions (id, label, summary) VALUES ('s1', '', '');
      INSERT INTO markers (session_id, kind, text) VALUES ('s1', 'decision', 'use qdrant');
      INSERT INTO markers (session_id, kind, text) VALUES ('s1', 'open', 'which model?');
    `);
    const stats = await computeCorpusStats(sqliteCorpusStatsDeps(db, dbPath));
    expect(stats.markers).toBe(2);
  });

  it("counts code exemplars", async () => {
    db.exec(`
      INSERT INTO code_exemplars (id, code_hash) VALUES ('e1', 'h1');
      INSERT INTO code_exemplars (id, code_hash) VALUES ('e2', 'h2');
    `);
    const stats = await computeCorpusStats(sqliteCorpusStatsDeps(db, dbPath));
    expect(stats.exemplars).toBe(2);
  });

  it("reports dbBytes from the file on disk", async () => {
    const stats = await computeCorpusStats(sqliteCorpusStatsDeps(db, dbPath));
    expect(stats.dbBytes).toBeGreaterThan(0);
  });
});

describe("parseCorpusThresholds", () => {
  it("returns defaults when env is empty", () => {
    const t = parseCorpusThresholds({});
    expect(t.warnBytes).toBe(1_000_000_000);
    expect(t.alertBytes).toBe(2_000_000_000);
  });

  it("parses valid numeric env values", () => {
    const t = parseCorpusThresholds({
      NLM_CORPUS_WARN_BYTES: "500000000",
      NLM_CORPUS_ALERT_BYTES: "1000000000",
    });
    expect(t.warnBytes).toBe(500_000_000);
    expect(t.alertBytes).toBe(1_000_000_000);
  });

  it("falls back to default for non-numeric warn value", () => {
    const t = parseCorpusThresholds({ NLM_CORPUS_WARN_BYTES: "notanumber" });
    expect(t.warnBytes).toBe(1_000_000_000);
    expect(t.alertBytes).toBe(2_000_000_000);
  });

  it("falls back to default for non-numeric alert value", () => {
    const t = parseCorpusThresholds({ NLM_CORPUS_ALERT_BYTES: "banana" });
    expect(t.alertBytes).toBe(2_000_000_000);
  });

  it("falls back to default for zero or negative values", () => {
    const t = parseCorpusThresholds({
      NLM_CORPUS_WARN_BYTES: "0",
      NLM_CORPUS_ALERT_BYTES: "-1",
    });
    expect(t.warnBytes).toBe(1_000_000_000);
    expect(t.alertBytes).toBe(2_000_000_000);
  });

  it("falls back to default for NaN-producing inputs", () => {
    const t = parseCorpusThresholds({
      NLM_CORPUS_WARN_BYTES: "NaN",
    });
    expect(t.warnBytes).toBe(1_000_000_000);
  });
});

describe("thresholdState", () => {
  const thresholds = { warnBytes: 1_000_000_000, alertBytes: 2_000_000_000 };

  it("returns ok below warn threshold", () => {
    expect(thresholdState(999_999_999, thresholds)).toBe("ok");
  });

  it("returns warn at warn threshold", () => {
    expect(thresholdState(1_000_000_000, thresholds)).toBe("warn");
  });

  it("returns warn between warn and alert", () => {
    expect(thresholdState(1_500_000_000, thresholds)).toBe("warn");
  });

  it("returns alert at alert threshold", () => {
    expect(thresholdState(2_000_000_000, thresholds)).toBe("alert");
  });

  it("returns alert above alert threshold", () => {
    expect(thresholdState(3_000_000_000, thresholds)).toBe("alert");
  });
});

describe("computeCorpusStats with fake deps", () => {
  it("passes through all stats from deps", async () => {
    const fakeDeps: CorpusStatsDeps = {
      getDbBytes: () => 42,
      getSessions: () => 10,
      getBodyStats: () => ({ bodyBytes: 500, cappedBodies: 2 }),
      getEntityStats: () => ({ entities: 100, hapaxEntities: 55 }),
      getFactStats: () => ({ factsActive: 20, factsSuperseded: 5, factsRetired: 3 }),
      getMarkers: () => 80,
      getExemplars: () => 7,
    };
    const stats = await computeCorpusStats(fakeDeps);
    expect(stats).toEqual({
      dbBytes: 42,
      sessions: 10,
      bodyBytes: 500,
      cappedBodies: 2,
      entities: 100,
      hapaxEntities: 55,
      factsActive: 20,
      factsSuperseded: 5,
      factsRetired: 3,
      markers: 80,
      exemplars: 7,
    });
  });
});
