import { statSync } from "node:fs";

export interface CorpusStats {
  readonly dbBytes: number;
  readonly sessions: number;
  readonly bodyBytes: number;
  readonly cappedBodies: number;
  readonly entities: number;
  readonly hapaxEntities: number;
  readonly factsActive: number;
  readonly factsSuperseded: number;
  readonly factsRetired: number;
  readonly markers: number;
  readonly exemplars: number;
}

export interface CorpusStatsDeps {
  getDbBytes(): number;
  getSessions(): number;
  getBodyStats():
    | { bodyBytes: number; cappedBodies: number }
    | Promise<{ bodyBytes: number; cappedBodies: number }>;
  getEntityStats(): { entities: number; hapaxEntities: number };
  getFactStats(): { factsActive: number; factsSuperseded: number; factsRetired: number };
  getMarkers(): number;
  getExemplars(): number;
}

export async function computeCorpusStats(deps: CorpusStatsDeps): Promise<CorpusStats> {
  const dbBytes = deps.getDbBytes();
  const sessions = deps.getSessions();
  const { bodyBytes, cappedBodies } = await deps.getBodyStats();
  const { entities, hapaxEntities } = deps.getEntityStats();
  const { factsActive, factsSuperseded, factsRetired } = deps.getFactStats();
  const markers = deps.getMarkers();
  const exemplars = deps.getExemplars();
  return {
    dbBytes,
    sessions,
    bodyBytes,
    cappedBodies,
    entities,
    hapaxEntities,
    factsActive,
    factsSuperseded,
    factsRetired,
    markers,
    exemplars,
  };
}

interface SqliteLike {
  prepare(sql: string): { get(...params: unknown[]): unknown };
}

export function sqliteCorpusStatsDeps(db: SqliteLike, dbPath: string): CorpusStatsDeps {
  return {
    getDbBytes() {
      return statSync(dbPath).size;
    },
    getSessions() {
      const row = db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number };
      return row.n;
    },
    async getBodyStats() {
      // better-sqlite3 is synchronous, and one SUM(LENGTH(body)) over the whole
      // table scans every overflow page (~600ms at 463MB, seconds at the alert
      // threshold) on the serving event loop. Chunk by rowid windows and yield
      // between chunks so each stall stays ~tens of ms.
      const CHUNK_ROWS = 500;
      const maxRow = db.prepare("SELECT COALESCE(MAX(rowid), 0) AS m FROM sessions").get() as {
        m: number;
      };
      let bodyBytes = 0;
      let cappedBodies = 0;
      for (let lo = 0; lo < maxRow.m; lo += CHUNK_ROWS) {
        const row = db
          .prepare(
            `SELECT
               COALESCE(SUM(LENGTH(body)), 0) AS bodyBytes,
               COUNT(CASE WHEN LENGTH(body) >= 200000 THEN 1 END) AS cappedBodies
             FROM sessions
             WHERE rowid > ? AND rowid <= ? AND body IS NOT NULL`,
          )
          .get(lo, lo + CHUNK_ROWS) as { bodyBytes: number; cappedBodies: number };
        bodyBytes += row.bodyBytes;
        cappedBodies += row.cappedBodies;
        await new Promise<void>((resolveYield) => setImmediate(resolveYield));
      }
      return { bodyBytes, cappedBodies };
    },
    getEntityStats() {
      const row = db
        .prepare(
          `SELECT
             COUNT(*) AS entities,
             COUNT(CASE WHEN session_count = 1 THEN 1 END) AS hapaxEntities
           FROM entities`,
        )
        .get() as { entities: number; hapaxEntities: number };
      return { entities: row.entities, hapaxEntities: row.hapaxEntities };
    },
    getFactStats() {
      const row = db
        .prepare(
          `SELECT
             COUNT(CASE WHEN retired_at IS NULL AND superseded_by IS NULL THEN 1 END) AS factsActive,
             COUNT(CASE WHEN retired_at IS NULL AND superseded_by IS NOT NULL THEN 1 END) AS factsSuperseded,
             COUNT(CASE WHEN retired_at IS NOT NULL THEN 1 END) AS factsRetired
           FROM facts`,
        )
        .get() as { factsActive: number; factsSuperseded: number; factsRetired: number };
      return {
        factsActive: row.factsActive,
        factsSuperseded: row.factsSuperseded,
        factsRetired: row.factsRetired,
      };
    },
    getMarkers() {
      const row = db.prepare("SELECT COUNT(*) AS n FROM markers").get() as { n: number };
      return row.n;
    },
    getExemplars() {
      const row = db.prepare("SELECT COUNT(*) AS n FROM code_exemplars").get() as { n: number };
      return row.n;
    },
  };
}

export interface CorpusThresholds {
  readonly warnBytes: number;
  readonly alertBytes: number;
}

const WARN_DEFAULT = 1_000_000_000;
const ALERT_DEFAULT = 2_000_000_000;

export function parseCorpusThresholds(env: Record<string, string | undefined>): CorpusThresholds {
  const warnRaw = env["NLM_CORPUS_WARN_BYTES"];
  const alertRaw = env["NLM_CORPUS_ALERT_BYTES"];

  const warnParsed = Number(warnRaw);
  const warnBytes =
    warnRaw === undefined || !Number.isFinite(warnParsed) || warnParsed <= 0
      ? WARN_DEFAULT
      : warnParsed;

  const alertParsed = Number(alertRaw);
  const alertBytes =
    alertRaw === undefined || !Number.isFinite(alertParsed) || alertParsed <= 0
      ? ALERT_DEFAULT
      : alertParsed;

  return { warnBytes, alertBytes };
}

export function thresholdState(
  dbBytes: number,
  thresholds: CorpusThresholds,
): "ok" | "warn" | "alert" {
  if (dbBytes >= thresholds.alertBytes) return "alert";
  if (dbBytes >= thresholds.warnBytes) return "warn";
  return "ok";
}
