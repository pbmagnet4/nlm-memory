/**
 * re_derivation_rate: how often the same decision is re-made across sessions
 * that share a topic but were never linked. A high rate means recall is failing
 * to surface the prior decision, so the operator (or an agent) re-derives it.
 *
 * A pair counts as a re-derivation when the two sessions share at least one
 * entity, sit more than GAP_DAYS apart, have decision text overlapping at or
 * above JACCARD_FLOOR, and have no `continues`/`supersedes` edge linking them.
 */

export interface ReDerivationSession {
  readonly id: string;
  readonly startedAt: string;
  readonly entities: ReadonlyArray<string>;
  readonly decisions: ReadonlyArray<string>;
}

export interface ReDerivationEdge {
  readonly from_session: string;
  readonly to_session: string;
  readonly kind: string;
}

export interface ReDerivationDeps {
  listSessionsWithin(windowDays: number): Promise<ReadonlyArray<ReDerivationSession>>;
  listEdges(): Promise<ReadonlyArray<ReDerivationEdge>>;
}

export interface ReDerivationPair {
  readonly a: string;
  readonly b: string;
  readonly sharedEntities: ReadonlyArray<string>;
  readonly jaccard: number;
}

export interface ReDerivationReport {
  readonly rate: number;
  readonly pairs: ReadonlyArray<ReDerivationPair>;
  /** Denominator: entity-sharing session pairs eligible for the rate. */
  readonly eligible: number;
}

const JACCARD_FLOOR = 0.5;
const GAP_DAYS = 7;
const MS_PER_DAY = 86_400_000;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function jaccard(a: ReadonlyArray<string>, b: ReadonlyArray<string>): number {
  const toks = (xs: ReadonlyArray<string>): Set<string> =>
    new Set(xs.join(" ").toLowerCase().split(/\W+/).filter(Boolean));
  const A = toks(a);
  const B = toks(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

interface SqliteLike {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
  };
}

/**
 * SQLite-backed deps for the CLI readout. Reads sessions started within the
 * window along with their entity links and decision markers, plus all edges.
 */
export function sqliteReDerivationDeps(db: SqliteLike): ReDerivationDeps {
  return {
    async listSessionsWithin(windowDays) {
      const rows = db
        .prepare(
          `SELECT id, started_at AS startedAt
             FROM sessions
            WHERE started_at >= datetime('now', ?)
            ORDER BY started_at ASC`,
        )
        .all(`-${windowDays} days`) as Array<{ id: string; startedAt: string }>;
      const entStmt = db.prepare(
        "SELECT entity_canonical AS e FROM session_entities WHERE session_id = ?",
      );
      const decStmt = db.prepare(
        "SELECT text AS t FROM markers WHERE session_id = ? AND kind = 'decision' ORDER BY position ASC",
      );
      return rows.map((r) => ({
        id: r.id,
        startedAt: r.startedAt,
        entities: (entStmt.all(r.id) as Array<{ e: string }>).map((x) => x.e),
        decisions: (decStmt.all(r.id) as Array<{ t: string }>).map((x) => x.t),
      }));
    },
    async listEdges() {
      return db
        .prepare("SELECT from_session, to_session, kind FROM session_edges")
        .all() as Array<ReDerivationEdge>;
    },
  };
}

export async function computeReDerivationRate(
  deps: ReDerivationDeps,
  windowDays: number,
): Promise<ReDerivationReport> {
  const sessions = await deps.listSessionsWithin(windowDays);
  const edges = await deps.listEdges();
  const linked = new Set(
    edges
      .filter((e) => e.kind === "continues" || e.kind === "supersedes")
      .map((e) => [e.from_session, e.to_session].sort().join("|")),
  );
  const pairs: ReDerivationPair[] = [];
  let eligible = 0;
  for (let i = 0; i < sessions.length; i++) {
    for (let j = i + 1; j < sessions.length; j++) {
      const s = sessions[i]!;
      const t = sessions[j]!;
      const shared = s.entities.filter((e) => t.entities.includes(e));
      if (shared.length === 0) continue;
      eligible++;
      const key = [s.id, t.id].sort().join("|");
      if (linked.has(key)) continue;
      const gap = Math.abs(new Date(t.startedAt).getTime() - new Date(s.startedAt).getTime()) / MS_PER_DAY;
      if (gap <= GAP_DAYS) continue;
      const jac = jaccard(s.decisions, t.decisions);
      if (jac >= JACCARD_FLOOR) {
        pairs.push({ a: s.id, b: t.id, sharedEntities: shared, jaccard: round2(jac) });
      }
    }
  }
  return { rate: eligible ? pairs.length / eligible : 0, pairs, eligible };
}
