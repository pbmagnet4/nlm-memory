import { chmodSync, writeFileSync } from "node:fs";
import { hostname, loadavg } from "node:os";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { SqliteSessionStore } from "../../src/core/storage/sqlite-session-store.js";
import { SqliteFactStore } from "../../src/core/storage/sqlite-fact-store.js";

const [snapshot, output, tenantId = "team_local", repeatArg = "3"] = process.argv.slice(2);
if (!snapshot || !output) throw new Error("usage: scoped-semantic-performance.ts <frozen.sqlite> <private-report.json> [tenantId] [repetitions]");
const repeats = Number(repeatArg);
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 20) throw new Error("repetitions must be 1..20");
const sessions = new SqliteSessionStore({ dbPath: resolve(snapshot), migrationsDir: resolve("migrations"), readonly: true });
const db = sessions.rawDb();
const facts = new SqliteFactStore(db);
const k = 20;
const scopes = db.prepare<[string], { id: string; n: number }>(`
  SELECT s.workstream_id id, COUNT(*) n FROM session_embedding_chunks sec
  JOIN sessions s ON s.id = sec.session_id
  WHERE s.tenant_id = ? AND s.workstream_id IS NOT NULL AND s.status NOT IN ('superseded','replaced')
  GROUP BY s.workstream_id ORDER BY n DESC, s.workstream_id
`).all(tenantId);
const selected = [...new Set([0, 1, Math.floor(scopes.length / 2), scopes.length - 1])].map((i) => scopes[i]).filter((x) => x !== undefined);
const counts = Object.fromEntries(["sessions", "facts", "session_embedding_chunks", "fact_embeddings", "session_chunk_map"].map((table) => [table, db.prepare<[], { n: number }>(`SELECT COUNT(*) n FROM ${table}`).get()!.n]));
const queryVectors = db.prepare<[string], { embedding: Buffer }>(`
  SELECT sec.embedding FROM session_embedding_chunks sec JOIN sessions s ON s.id = sec.session_id
  WHERE s.tenant_id = ? AND s.status NOT IN ('superseded','replaced')
  ORDER BY sec.chunk_id LIMIT 3
`).all(tenantId).map(({ embedding }) => new Float32Array(embedding.buffer.slice(embedding.byteOffset, embedding.byteOffset + embedding.byteLength)));
if (queryVectors.length !== 3) throw new Error("frozen corpus must contain at least three query-source vectors");
const firstUse: { arm: string; repetition: number; ms: number; returned: number }[] = [];
const measurements: { scope: string | null; lane: string; variant: string; repetition: number; query: number; ms: number; returned: number }[] = [];
function timed<T extends readonly unknown[]>(run: () => T): { rows: T; ms: number } {
  const start = performance.now();
  const rows = run();
  return { rows, ms: performance.now() - start };
}
function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return { n: sorted.length, min: sorted[0], p50: sorted[Math.ceil(sorted.length * 0.5) - 1], p95: sorted[Math.ceil(sorted.length * 0.95) - 1], max: sorted.at(-1) };
}
const groupedSession = (scoped: boolean) => db.prepare<unknown[], { session_id: string; chunk_idx: number; distance: number }>(`
  WITH eligible AS MATERIALIZED (
    SELECT sec.session_id, sec.chunk_idx, vec_distance_L2(sec.embedding, ?) distance
    FROM session_embedding_chunks sec JOIN sessions s ON s.id = sec.session_id
    WHERE s.tenant_id = ? AND s.status NOT IN ('superseded','replaced') ${scoped ? "AND s.workstream_id = ?" : ""}
  ), best AS (SELECT session_id, MIN(distance) distance FROM eligible GROUP BY session_id)
  SELECT best.session_id, best.distance, MIN(eligible.chunk_idx) chunk_idx
  FROM best JOIN eligible ON eligible.session_id = best.session_id AND eligible.distance = best.distance
  GROUP BY best.session_id, best.distance ORDER BY best.distance, best.session_id LIMIT ?
`);
const oldSession = (scoped: boolean) => db.prepare<unknown[], { session_id: string; distance: number; chunk_idx: number }>(`
  WITH candidates AS MATERIALIZED (
    SELECT session_id, chunk_idx, distance FROM session_embedding_chunks WHERE embedding MATCH ? AND k = ? ORDER BY distance
  ), ranked AS (
    SELECT c.*, ROW_NUMBER() OVER (PARTITION BY c.session_id ORDER BY c.distance, c.chunk_idx) rank
    FROM candidates c JOIN sessions s ON s.id = c.session_id
    WHERE s.tenant_id = ? AND s.status NOT IN ('superseded','replaced') ${scoped ? "AND s.workstream_id = ?" : ""}
  ) SELECT session_id, chunk_idx, distance FROM ranked WHERE rank = 1 ORDER BY distance, session_id LIMIT ?
`);
const oldFact = (scoped: boolean) => db.prepare<unknown[], { fact_id: string; distance: number }>(`
  WITH candidates AS MATERIALIZED (
    SELECT fact_id, distance FROM fact_embeddings WHERE embedding MATCH ? AND k = ? ORDER BY distance
  ) SELECT c.* FROM candidates c JOIN facts f ON f.id = c.fact_id JOIN sessions s ON s.id = f.source_session_id
  WHERE f.tenant_id = ? AND s.tenant_id = ? AND f.confidence >= 0.5 AND f.superseded_by IS NULL AND f.retired_at IS NULL
    ${scoped ? "AND s.workstream_id = ?" : ""}
  ORDER BY distance, fact_id LIMIT ?
`);
const scopeCounts: unknown[] = [];
try {
  for (const [scopeIndex, scope] of [undefined, ...selected.map((s) => s.id)].entries()) {
    console.error(JSON.stringify({ progress: "scope", scopeIndex, totalScopes: selected.length + 1 }));
    const sessionCount = db.prepare<unknown[], { vectors: number; units: number }>(`
      SELECT COUNT(*) vectors, COUNT(DISTINCT sec.session_id) units FROM session_embedding_chunks sec JOIN sessions s ON s.id = sec.session_id
      WHERE s.tenant_id = ? AND s.status NOT IN ('superseded','replaced') ${scope ? "AND s.workstream_id = ?" : ""}
    `).get(...[tenantId, ...(scope ? [scope] : [])]);
    const factCount = db.prepare<unknown[], { vectors: number }>(`
      SELECT COUNT(*) vectors FROM fact_embeddings fe JOIN facts f ON f.id = fe.fact_id JOIN sessions s ON s.id = f.source_session_id
      WHERE f.tenant_id = ? AND s.tenant_id = ? AND f.confidence >= 0.5 AND f.superseded_by IS NULL AND f.retired_at IS NULL ${scope ? "AND s.workstream_id = ?" : ""}
    `).get(tenantId, tenantId, ...(scope ? [scope] : []));
    scopeCounts.push({ scope: scope ?? null, session: sessionCount, fact: factCount });
    for (let repetition = 0; repetition < repeats; repetition++) {
      for (const [query, vector] of queryVectors.entries()) {
        const blob = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
        const sessionStart = performance.now();
        const exact = await sessions.semanticSearch(tenantId, vector, k, scope ? { workstreamIds: [scope] } : {});
        measurements.push({ scope: scope ?? null, lane: "session", variant: "exact-adapter", repetition, query, ms: performance.now() - sessionStart, returned: exact.length });
        const grouped = timed(() => groupedSession(!!scope).all(blob, tenantId, ...(scope ? [scope] : []), k));
        if (grouped.rows.some((row, i) => row.session_id !== exact[i]?.sessionId || row.chunk_idx !== exact[i]?.chunkIndex || Math.abs(row.distance - exact[i]!.distance) > 1e-5) || grouped.rows.length !== exact.length) throw new Error("grouped SQL variant differs from adapter");
        measurements.push({ scope: scope ?? null, lane: "session", variant: "exact-grouped-sql", repetition, query, ms: grouped.ms, returned: grouped.rows.length });
        const priorSession = timed(() => oldSession(!!scope).all(blob, k * 4, tenantId, ...(scope ? [scope] : []), k));
        measurements.push({ scope: scope ?? null, lane: "session", variant: "prior-fixed-window-sql", repetition, query, ms: priorSession.ms, returned: priorSession.rows.length });
        const factStart = performance.now();
        const exactFacts = await facts.semanticSearch(tenantId, vector, k, { minConfidence: 0.5, ...(scope ? { workstreamIds: [scope] } : {}) });
        measurements.push({ scope: scope ?? null, lane: "fact", variant: "exact-adapter", repetition, query, ms: performance.now() - factStart, returned: exactFacts.length });
        const priorFact = timed(() => oldFact(!!scope).all(blob, k * 4, tenantId, tenantId, ...(scope ? [scope] : []), k));
        measurements.push({ scope: scope ?? null, lane: "fact", variant: "prior-fixed-window-sql", repetition, query, ms: priorFact.ms, returned: priorFact.rows.length });
      }
    }
  }
  // Reopen each arm so the old KNN cost is compared at the same connection lifecycle.
  for (let repetition = 0; repetition < 3; repetition++) {
    for (const arm of (repetition % 2 === 0 ? ["prior", "candidate"] : ["candidate", "prior"])) {
      const fresh = new SqliteSessionStore({ dbPath: resolve(snapshot!), migrationsDir: resolve("migrations"), readonly: true });
      try {
        const vector = queryVectors[0]!;
        const start = performance.now();
        const rows = arm === "candidate" ? await fresh.semanticSearch(tenantId!, vector, k)
          : fresh.rawDb().prepare<[Buffer, number], { session_id: string; distance: number; chunk_idx: number }>(`
            SELECT session_id, distance, chunk_idx FROM session_embedding_chunks WHERE embedding MATCH ? AND k = ? ORDER BY distance
          `).all(Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength), k * 4);
        firstUse.push({ arm, repetition, ms: performance.now() - start, returned: rows.length });
      } finally { fresh.close(); }
    }
  }
  const groups = new Map<string, number[]>();
  for (const m of measurements) {
    const key = `${m.scope === null ? "all" : "scoped"}/${m.lane}/${m.variant}`;
    groups.set(key, [...groups.get(key) ?? [], m.ms]);
  }
  const summary = Object.fromEntries([...groups].map(([key, values]) => [key, distribution(values)]));
  const report = { snapshot: resolve(snapshot), output: resolve(output), tenantId, host: hostname(), loadavg: loadavg(), createdAt: new Date().toISOString(), counts, scopeCounts, k, repeats,
    sqlite: db.prepare("SELECT sqlite_version() sqlite, vec_version() vec").get(), embeddingConfig: db.prepare("SELECT lane, provider, model, dim FROM embedding_config").all(),
    firstUse, firstUseSummary: Object.fromEntries(["prior", "candidate"].map((arm) => [arm, distribution(firstUse.filter((m) => m.arm === arm).map((m) => m.ms))])),
    conditions: ["Frozen snapshot opened readonly; no migrations and no live database.", "Persisted prose vectors reused as synthetic query vectors; three deterministic source chunks; no network/model calls.", "Native SQL and adapter SQL time only. OS cache uncontrolled; sequential reuse is warm-path evidence, not a cold-OS or end-to-end latency measurement.", "Prior SQL measures conservative fixed-window cost; it adds eligibility/grouping in SQL instead of the former service metadata reads.", "Scoped set includes two largest, median and smallest chunk-populated workstreams; scopes are actual frozen membership.", "Synchronous SQLite calls block the event loop. A JavaScript timeout cannot preempt a running SQL statement.", "No answer-quality, evidence-sufficiency, token-cost or promotion claims. Holdout was not loaded or scored."], summary, measurements };
  writeFileSync(output, JSON.stringify(report, null, 2), { mode: 0o600 });
  chmodSync(output, 0o600);
  console.log(JSON.stringify({ counts, summary, firstUseSummary: report.firstUseSummary, privateReport: resolve(output) }, null, 2));
} finally { sessions.close(); }
