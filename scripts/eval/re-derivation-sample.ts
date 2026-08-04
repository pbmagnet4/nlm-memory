/**
 * Stage A sampler: freezes a labelling frame from the live corpus and draws a
 * stratified sample of candidate re-derivation pairs.
 *
 * Spec: docs/superpowers/specs/2026-08-04-stage-a-detector-calibration-design.md
 *
 * Two things here are load-bearing and easy to get wrong:
 *
 *  1. The window is resolved to literal timestamps ONCE and written to
 *     frame.json. The daemon ingests continuously, so `datetime('now')`
 *     evaluated twice returns two different frames - two runs eleven minutes
 *     apart during design disagreed by 466 pairs. Every downstream stage reads
 *     the frozen file rather than re-querying.
 *
 *  2. Pairs are sorted before sampling. allocatedSample seeds its shuffle but
 *     shuffles the pool as handed to it, so enumerating out of a Set without
 *     sorting yields a different sample on a re-run despite the same seed.
 *
 * Full pair features are computed only for the ~303 sampled pairs. The frame is
 * ~469k pairs and maxPairJaccard is O(|decisions_a| x |decisions_b|), so
 * stratification uses the cheap pooled feature and the expensive ones are paid
 * for once, at the end.
 *
 * Usage: npm run eval:rederiv-sample
 */

import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { buildEmbedder } from "../../src/llm/build-embedder.js";
import { DEFAULT_TEAM_ID } from "../../src/core/tenancy/default-team.js";
import { deriveSeed } from "./lib/recall-impact-replay-lib.js";
import { allocatedSample, balancedQuota } from "./lib/re-derivation-sampling.js";
import { pairFeatures, tokenize, type SessionDecisions } from "./lib/re-derivation-features.js";

const WINDOW_DAYS = 90;
const GAP_DAYS = 7;
const SEED = 20260804;
const OUT_DIR = join(process.cwd(), "reports", "re-derivation");
const VEC_CACHE = join(OUT_DIR, "decision-vectors.jsonl");
const EMBED_CONCURRENCY = 4;
const EXCERPT_CHARS = 1500;
const P2_TOP_K = 5_000;
const P2_PRUNE_AT = 20_000;

const QUOTAS: Record<string, number> = {
  A1: 53, A2: 45, A3: 45, A4: 40, A5: 30, P1: 30, P2: 30, P3: 30,
};

interface Row {
  readonly id: string;
  readonly label: string;
  readonly startedAt: string;
  readonly excerpt: string;
  readonly decisions: ReadonlyArray<string>;
  readonly entities: ReadonlyArray<string>;
}

function log(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

// --- corpus load ------------------------------------------------------------

function loadCorpus(): {
  window: { lo: string; hi: string; days: number };
  sessions: Map<string, Row>;
  totalInWindow: number;
  edges: Set<string>;
} {
  const dbPath = process.env["NLM_DB"] ?? join(homedir(), ".nlm", "canonical.sqlite");
  const db = new Database(dbPath, { readonly: true });

  const w = db
    .prepare(`SELECT datetime('now', ?) AS lo, datetime('now') AS hi`)
    .get(`-${WINDOW_DAYS} days`) as { lo: string; hi: string };
  log(`window frozen: ${w.lo} .. ${w.hi}`);

  const all = db
    .prepare(
      `SELECT id, COALESCE(label,'') AS label, started_at AS startedAt,
              COALESCE(summary, substr(COALESCE(body,''), 1, ?)) AS excerpt
         FROM sessions
        WHERE started_at >= ? AND started_at < ? AND tenant_id = ?
        ORDER BY id ASC`,
    )
    .all(EXCERPT_CHARS, w.lo, w.hi, DEFAULT_TEAM_ID) as Array<{
    id: string; label: string; startedAt: string; excerpt: string;
  }>;

  const decStmt = db.prepare(
    "SELECT text AS t FROM markers WHERE session_id = ? AND kind = 'decision' ORDER BY position ASC",
  );
  const entStmt = db.prepare(
    "SELECT entity_canonical AS e FROM session_entities WHERE session_id = ?",
  );

  const sessions = new Map<string, Row>();
  for (const s of all) {
    const decisions = (decStmt.all(s.id) as Array<{ t: string }>).map((x) => x.t);
    if (decisions.length === 0) continue; // decisionless sides can never be positive
    sessions.set(s.id, {
      id: s.id,
      label: s.label,
      startedAt: s.startedAt,
      excerpt: (s.excerpt ?? "").slice(0, EXCERPT_CHARS),
      decisions,
      entities: (entStmt.all(s.id) as Array<{ e: string }>).map((x) => x.e).sort(),
    });
  }

  const edges = new Set<string>();
  for (const e of db
    .prepare("SELECT from_session, to_session, kind FROM session_edges")
    .all() as Array<{ from_session: string; to_session: string; kind: string }>) {
    if (e.kind === "continues" || e.kind === "supersedes") {
      edges.add([e.from_session, e.to_session].sort().join("|"));
    }
  }

  db.close();
  return { window: { ...w, days: WINDOW_DAYS }, sessions, totalInWindow: all.length, edges };
}

// --- embeddings -------------------------------------------------------------

function loadVecCache(): Map<string, Float32Array> {
  const cache = new Map<string, Float32Array>();
  if (!existsSync(VEC_CACHE)) return cache;
  for (const line of readFileSync(VEC_CACHE, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as { k: string; v: number[] };
      cache.set(r.k, Float32Array.from(r.v));
    } catch {
      // a torn final line from an interrupted run - skip it, the text re-embeds
    }
  }
  return cache;
}

async function embedDecisions(sessions: Map<string, Row>): Promise<Map<string, Float32Array>> {
  const embedder = buildEmbedder();
  const model = process.env["NLM_EMBED_MODEL"] ?? "unknown";
  const cache = loadVecCache();
  log(`vector cache: ${cache.size} hits on disk`);

  const wanted = new Map<string, string>(); // key -> text
  for (const s of sessions.values()) {
    for (const d of s.decisions) {
      const k = createHash("sha256").update(`${model}:${d}`).digest("hex");
      if (!cache.has(k)) wanted.set(k, d);
    }
  }
  const todo = [...wanted.entries()];
  log(`embedding ${todo.length} new decision markers`);

  let done = 0;
  const workers = Array.from({ length: EMBED_CONCURRENCY }, async (_, w) => {
    for (let i = w; i < todo.length; i += EMBED_CONCURRENCY) {
      const [k, text] = todo[i]!;
      const { vector } = await embedder.embed(text, "document");
      cache.set(k, vector);
      appendFileSync(VEC_CACHE, `${JSON.stringify({ k, v: [...vector] })}\n`);
      if (++done % 500 === 0) log(`  embedded ${done}/${todo.length}`);
    }
  });
  await Promise.all(workers);

  const byKey = new Map<string, Float32Array>();
  for (const s of sessions.values()) {
    for (const d of s.decisions) {
      const k = createHash("sha256").update(`${model}:${d}`).digest("hex");
      const v = cache.get(k);
      if (v) byKey.set(`${s.id}|${d}`, v);
    }
  }
  return byKey;
}

function pooledVectors(
  sessions: Map<string, Row>,
  decVecs: Map<string, Float32Array>,
): { ids: string[]; mat: Float32Array; dim: number } {
  const ids = [...sessions.keys()].sort();
  let dim = 0;
  for (const v of decVecs.values()) { dim = v.length; break; }
  const mat = new Float32Array(ids.length * dim);
  ids.forEach((id, row) => {
    const s = sessions.get(id)!;
    const acc = new Float64Array(dim);
    let n = 0;
    for (const d of s.decisions) {
      const v = decVecs.get(`${id}|${d}`);
      if (!v) continue;
      for (let i = 0; i < dim; i++) acc[i]! += v[i]!;
      n++;
    }
    if (n === 0) return;
    let norm = 0;
    for (let i = 0; i < dim; i++) norm += (acc[i]! / n) ** 2;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < dim; i++) mat[row * dim + i] = acc[i]! / n / norm;
  });
  return { ids, mat, dim };
}

// --- main -------------------------------------------------------------------

interface Cand {
  readonly pairId: string;
  readonly a: string;
  readonly b: string;
  readonly jPrime: number;
  readonly cos: number;
  readonly gapDays: number;
  readonly shared: number;
  stratum: string;
  sizeTercile: string;
  readonly minStrippedTokens: number;
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const { window, sessions, totalInWindow, edges } = loadCorpus();
  log(`sessions in window: ${totalInWindow}; decision-bearing: ${sessions.size}`);

  const decVecs = await embedDecisions(sessions);
  const { ids, mat, dim } = pooledVectors(sessions, decVecs);
  const idx = new Map(ids.map((id, i) => [id, i]));
  log(`pooled vectors: ${ids.length} x ${dim}`);

  const strippedToks = new Map<string, Set<string>>();
  const entSets = new Map<string, Set<string>>();
  const startMs = new Map<string, number>();
  for (const s of sessions.values()) {
    strippedToks.set(s.id, tokenize(s.decisions, true));
    entSets.set(s.id, new Set(s.entities));
    startMs.set(s.id, new Date(s.startedAt).getTime());
  }

  const cos = (a: string, b: string): number => {
    const ia = idx.get(a)! * dim;
    const ib = idx.get(b)! * dim;
    let d = 0;
    for (let i = 0; i < dim; i++) d += mat[ia + i]! * mat[ib + i]!;
    return d;
  };

  const frame: Cand[] = [];
  const p1Pool: Cand[] = [];
  const p2Top: Cand[] = [];
  let p2Seen = 0;
  let detectorEligible = 0;
  let decisionlessSide = 0;
  let linkedCount = 0;

  // Reproduce the detector's own eligible counter, which increments on
  // entity-sharing BEFORE it looks at decisions - that is Finding D.
  {
    const db = new Database(process.env["NLM_DB"] ?? join(homedir(), ".nlm", "canonical.sqlite"), {
      readonly: true,
    });
    const inWindow = db
      .prepare(
        `SELECT s.id AS id, se.entity_canonical AS e
           FROM sessions s JOIN session_entities se ON se.session_id = s.id
          WHERE s.started_at >= ? AND s.started_at < ? AND s.tenant_id = ?`,
      )
      .all(window.lo, window.hi, DEFAULT_TEAM_ID) as Array<{ id: string; e: string }>;
    db.close();
    const byEnt = new Map<string, string[]>();
    for (const r of inWindow) {
      const list = byEnt.get(r.e);
      if (list) list.push(r.id);
      else byEnt.set(r.e, [r.id]);
    }
    const seen = new Set<string>();
    for (const list of byEnt.values()) {
      const uniq = [...new Set(list)].sort();
      for (let i = 0; i < uniq.length; i++) {
        for (let j = i + 1; j < uniq.length; j++) {
          const k = `${uniq[i]}|${uniq[j]}`;
          if (seen.has(k)) continue;
          seen.add(k);
          detectorEligible++;
          if (!sessions.has(uniq[i]!) || !sessions.has(uniq[j]!)) decisionlessSide++;
        }
      }
    }
  }
  log(`detector eligible: ${detectorEligible}; decisionless side: ${decisionlessSide}`);

  const dIds = [...sessions.keys()].sort();
  for (let i = 0; i < dIds.length; i++) {
    for (let j = i + 1; j < dIds.length; j++) {
      const a0 = dIds[i]!;
      const b0 = dIds[j]!;
      const [a, b] = startMs.get(a0)! <= startMs.get(b0)! ? [a0, b0] : [b0, a0];
      const ea = entSets.get(a)!;
      let shared = 0;
      for (const e of entSets.get(b)!) if (ea.has(e)) shared++;
      const gapDays = Math.abs(startMs.get(b)! - startMs.get(a)!) / 86_400_000;
      const jPrime = jaccard(strippedToks.get(a)!, strippedToks.get(b)!);
      const c = cos(a, b);
      const cand: Cand = {
        pairId: `${a}|${b}`,
        a, b, jPrime, cos: c, gapDays, shared,
        stratum: "", sizeTercile: "",
        minStrippedTokens: Math.min(strippedToks.get(a)!.size, strippedToks.get(b)!.size),
      };
      if (shared === 0) {
        p2Seen++;
        // Bounded top-K by cosine. Materialising all ~4M zero-entity pairs as
        // objects costs ~800MB; and a 30-of-401,581 decile sample would carry a
        // hopeless interval anyway. P2 is therefore the top P2_TOP_K by pooled
        // decision cosine, an exact population, with the remaining zero-entity
        // pairs declared uncovered in frame.json rather than silently weighted.
        if (p2Top.length >= P2_PRUNE_AT) {
          p2Top.sort((x, y) => y.cos - x.cos || x.pairId.localeCompare(y.pairId));
          p2Top.length = P2_TOP_K;
        }
        if (p2Top.length < P2_TOP_K || cand.cos > p2Top[p2Top.length - 1]!.cos) p2Top.push(cand);
        continue;
      }
      if (edges.has([a, b].sort().join("|"))) { linkedCount++; continue; }
      if (gapDays <= GAP_DAYS) {
        if (jPrime >= 0.15) p1Pool.push(cand);
        continue;
      }
      frame.push(cand);
    }
  }
  p2Top.sort((x, y) => y.cos - x.cos || x.pairId.localeCompare(y.pairId));
  p2Top.length = Math.min(p2Top.length, P2_TOP_K);
  log(`frame: ${frame.length}; P1 pool: ${p1Pool.length}; P2 seen: ${p2Seen} (top ${p2Top.length} kept); linked: ${linkedCount}`);

  // Stratify. P3 (top 1% cosine within J'=0) is carved BEFORE A5 so they cannot overlap.
  const zero = frame.filter((c) => c.jPrime === 0).sort((x, y) => y.cos - x.cos || x.pairId.localeCompare(y.pairId));
  const p3Size = Math.max(1, Math.round(zero.length * 0.01));
  const p3Ids = new Set(zero.slice(0, p3Size).map((c) => c.pairId));

  for (const c of frame) {
    if (c.jPrime >= 0.35) c.stratum = "A1";
    else if (c.jPrime >= 0.15) c.stratum = "A2";
    else if (c.jPrime >= 0.05) c.stratum = "A3";
    else if (c.jPrime > 0) c.stratum = "A4";
    else c.stratum = p3Ids.has(c.pairId) ? "P3" : "A5";
  }
  for (const c of p1Pool) c.stratum = "P1";

  for (const c of p2Top) c.stratum = "P2";

  const pool = [...frame, ...p1Pool, ...p2Top].sort((x, y) => x.pairId.localeCompare(y.pairId));

  const populations: Record<string, number> = {};
  for (const c of pool) populations[c.stratum] = (populations[c.stratum] ?? 0) + 1;

  // Size terciles are computed WITHIN each stratum, then the quota is split
  // across them, so the high-J' strata cannot resolve to pure short-subagent
  // boilerplate - which is the confound Stage A exists to measure.
  const selected: Cand[] = [];
  const drawn: Record<string, number> = {};
  const shortfalls: Array<{ stratum: string; wanted: number; available: number }> = [];

  for (const [stratum, quota] of Object.entries(QUOTAS)) {
    const rows = pool.filter((c) => c.stratum === stratum);
    if (rows.length === 0) {
      drawn[stratum] = 0;
      shortfalls.push({ stratum, wanted: quota, available: 0 });
      continue;
    }
    const sortedBySize = [...rows].sort(
      (x, y) => x.minStrippedTokens - y.minStrippedTokens || x.pairId.localeCompare(y.pairId),
    );
    const t1 = Math.floor(sortedBySize.length / 3);
    const t2 = Math.floor((2 * sortedBySize.length) / 3);
    sortedBySize.forEach((c, i) => {
      c.sizeTercile = i < t1 ? "small" : i < t2 ? "mid" : "large";
    });
    const tercileQuota = balancedQuota(rows, (c) => c.sizeTercile, Math.min(quota, rows.length));
    const r = allocatedSample(rows, (c) => c.sizeTercile, tercileQuota, deriveSeed(SEED, stratum));
    selected.push(...r.selected);
    drawn[stratum] = r.selected.length;
    if (r.selected.length < quota) {
      shortfalls.push({ stratum, wanted: quota, available: rows.length });
    }
  }

  // Full features are paid for here, on ~303 pairs, not on 469k.
  const lines = selected
    .sort((x, y) => x.pairId.localeCompare(y.pairId))
    .map((c) => {
      const A = sessions.get(c.a)!;
      const B = sessions.get(c.b)!;
      const toSd = (r: Row): SessionDecisions => ({
        id: r.id, startedAt: r.startedAt, decisions: r.decisions, entities: r.entities,
      });
      const f = pairFeatures(toSd(A), toSd(B), {
        aVectors: A.decisions.map((d) => decVecs.get(`${A.id}|${d}`)).filter(Boolean) as Float32Array[],
        bVectors: B.decisions.map((d) => decVecs.get(`${B.id}|${d}`)).filter(Boolean) as Float32Array[],
        linked: false,
      });
      return JSON.stringify({
        pairId: c.pairId,
        stratum: c.stratum,
        sizeTercile: c.sizeTercile,
        features: { ...f, pooledCosine: c.cos },
        a: { id: A.id, label: A.label, startedAt: A.startedAt, decisions: A.decisions, excerpt: A.excerpt },
        b: { id: B.id, label: B.label, startedAt: B.startedAt, decisions: B.decisions, excerpt: B.excerpt },
      });
    });

  writeFileSync(join(OUT_DIR, "sample.jsonl"), `${lines.join("\n")}\n`);

  const strata: Record<string, unknown> = {};
  const defs: Record<string, string> = {
    A1: "J' >= 0.35", A2: "J' in [0.15,0.35)", A3: "J' in [0.05,0.15)",
    A4: "J' in (0,0.05)", A5: "J' = 0, minus P3",
    P1: "gap <= 7d, unlinked, J' >= 0.15", P2: `zero shared entities, top ${P2_TOP_K} by pooled cosine`,
    P3: "J' = 0, top 1% pooled cosine",
  };
  for (const k of Object.keys(QUOTAS)) {
    strata[k] = {
      definition: defs[k], population: populations[k] ?? 0,
      quota: QUOTAS[k], drawn: drawn[k] ?? 0,
    };
  }

  writeFileSync(
    join(OUT_DIR, "frame.json"),
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        window,
        corpus: { sessionsInWindow: totalInWindow, decisionBearing: sessions.size },
        detectorEligible,
        decisionlessSidePairs: decisionlessSide,
        frameSize: frame.length,
        zeroEntityPairsSeen: p2Seen,
        zeroEntityUncovered: p2Seen - p2Top.length,
        strata,
        seed: SEED,
        embedModel: process.env["NLM_EMBED_MODEL"] ?? "unknown",
        shortfalls,
      },
      null,
      2,
    )}\n`,
  );

  log(`wrote ${lines.length} sampled pairs`);
  if (shortfalls.length) log(`SHORTFALLS: ${JSON.stringify(shortfalls)}`);
}

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`);
  process.exit(1);
});
