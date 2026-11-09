/**
 * Promotion dream pass (T1611).
 *
 * Background "dreaming" lane: sample active (current, non-retired) facts,
 * score them with the scoring core (dream/promotion.ts) against recent
 * hook/citation telemetry, and — in apply mode — record the capped
 * nomination set in fact_promotions and demote whatever fell out.
 *
 * Invariants (docs/supersedence.md — "preserve the trail, mark it
 * explicitly"):
 *  - Dry-run by default. Nothing is written unless `apply` is explicitly
 *    true (the scheduler wiring gates it behind NLM_DREAM_PROMOTE_APPLY).
 *  - A demoted promotion is never deleted. The row survives with demoted_at
 *    + demote_reason — the link explaining what was nominated and why it
 *    was withdrawn — the promotion analog of the contradiction pass's
 *    retire and the dedup pass's markSuperseded.
 *  - The pass NOMINATES capped candidates for the pointer-block injection
 *    path; it never rewires hook injection itself. The hook keeps composing
 *    from live recall; promotions are the dream lane's evidence-backed
 *    suggestion set, bounded by MAX_PROMOTION_LINES / MAX_PROMOTION_BYTES.
 *  - A failed telemetry read yields empty signals (and a null injection
 *    snapshot), never a failed run; sampling another day gets another shot.
 *
 * Scheduler wiring: this module owns the policy (env flags, defaults, the
 * SQLite sampler + promotion store + telemetry readers); the scheduler is
 * a dumb host for periodic passes. The single entry point is
 * registerPromotionPass().
 */

import { existsSync, readFileSync } from "node:fs";
import type Database from "better-sqlite3";
import { DEFAULT_TEAM_ID } from "@core/tenancy/default-team.js";
import { tenantClause } from "@core/tenancy/tenant-clause.js";
import { tenantStatePath } from "@core/tenancy/tenant-state-path.js";
import {
  injectionCostPerUsefulHit,
  type CitationRow,
  type HookFireRow,
  type InjectionCost,
} from "@core/eval/dream-metrics.js";
import {
  countIn,
  enforcePromotionCap,
  findDemotions,
  isPromotionEligible,
  promotionReason,
  renderPromotionLine,
  scorePromotionCandidate,
  MAX_PROMOTION_BYTES,
  MAX_PROMOTION_LINES,
  type PromotionCandidate,
  type PromotionNominee,
  type PromotionSignals,
  type PromotionStanding,
} from "./promotion.js";

/** Enable the scheduled wiring (registerPromotionPass). Off unless 1/true. */
export const DREAM_PROMOTE_PASS_ENV = "NLM_DREAM_PROMOTE_PASS";
/** Mutate (promote + demote) instead of report-only. Off unless 1/true. */
export const DREAM_PROMOTE_APPLY_ENV = "NLM_DREAM_PROMOTE_APPLY";
/** Facts considered per run. */
export const DREAM_PROMOTE_SAMPLE_ENV = "NLM_DREAM_PROMOTE_SAMPLE";
/** Cap overrides: lines and bytes of rendered promotion text. */
export const DREAM_PROMOTE_MAX_LINES_ENV = "NLM_DREAM_PROMOTE_MAX_LINES";
export const DREAM_PROMOTE_MAX_BYTES_ENV = "NLM_DREAM_PROMOTE_MAX_BYTES";
/** Telemetry window (days) for retrieval/citation signals. */
export const DREAM_PROMOTE_WINDOW_DAYS_ENV = "NLM_DREAM_PROMOTE_WINDOW_DAYS";

/** Once a day — the pass is a nightly sweep, not a per-tick cost. */
export const DEFAULT_PASS_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_SAMPLE_SIZE = 200;
export const DEFAULT_WINDOW_DAYS = 30;

/** `source`-style stamp for promotion reasons. */
export const PROMOTION_PASS_SOURCE = "dream-promotion-pass";

/** Periodic background pass hosted by the scheduler (same shape as the
 *  contradiction/dedup passes; the scheduler stays pass-agnostic). */
export interface PromotionPassSpec {
  readonly name: string;
  readonly intervalMs: number;
  run(): Promise<void>;
}

export interface PromotionPassHost {
  registerDreamPass(pass: PromotionPassSpec): void;
}

export type PromotionAction = "promote" | "demote" | "keep" | "skip";

export interface PromotionFinding {
  readonly factId: string;
  readonly action: PromotionAction;
  readonly score: number;
  /** Audit-facing evidence line (promote reason or demote reason). */
  readonly reason: string;
  /** True only when apply was set AND the write actually happened. */
  readonly written: boolean;
  readonly error?: string;
}

export interface PromotionPassReport {
  readonly apply: boolean;
  readonly sampled: number;
  readonly eligible: number;
  readonly nominated: number;
  readonly promoted: number;
  readonly demoted: number;
  readonly capLines: number;
  readonly capBytes: number;
  readonly usedLines: number;
  readonly usedBytes: number;
  /**
   * Injection ledger entry for this run: the existing
   * injectionCostPerUsefulHit scorer over the telemetry window. Null when
   * the logs are absent. Before/after is read run-over-run — this run's
   * measurement is next run's "before".
   */
  readonly injection: InjectionCost | null;
  readonly findings: ReadonlyArray<PromotionFinding>;
}

export interface PromotionRow {
  readonly factId: string;
  readonly promotedAt: string;
  readonly score: number;
  readonly demotedAt: string | null;
}

/** Pass-local promotion store over the SQLite handle. The table is
 *  pass-owned (migration 049); the PG backend never gets here (self-skip). */
export class SqlitePromotionStore {
  constructor(private readonly db: Database.Database) {}

  listActive(tenantId: string): PromotionStanding[] {
    const tc = tenantClause(tenantId);
    return this.db
      .prepare<[string], { fact_id: string; promoted_at: string; score: number }>(
        `SELECT fact_id, promoted_at, score FROM fact_promotions
         WHERE demoted_at IS NULL AND ${tc.sql}`,
      )
      .all(tc.param)
      .map((r) => ({ factId: r.fact_id, promotedAt: r.promoted_at, score: r.score }));
  }

  promote(tenantId: string, nominee: PromotionNominee): void {
    this.db
      .prepare(
        `INSERT INTO fact_promotions (fact_id, tenant_id, promoted_at, score, reason, demoted_at, demote_reason)
         VALUES (?, ?, datetime('now'), ?, ?, NULL, NULL)
         ON CONFLICT (fact_id) DO UPDATE SET
           tenant_id = excluded.tenant_id, score = excluded.score, reason = excluded.reason,
           demoted_at = NULL, demote_reason = NULL`,
      )
      .run(nominee.id, tenantId, nominee.score, nominee.reason);
  }

  demote(tenantId: string, factId: string, reason: string): void {
    const tc = tenantClause(tenantId);
    this.db
      .prepare(
        `UPDATE fact_promotions SET demoted_at = datetime('now'), demote_reason = ?
         WHERE fact_id = ? AND demoted_at IS NULL AND ${tc.sql}`,
      )
      .run(reason, factId, tc.param);
  }
}

function flagEnabled(raw: string | undefined): boolean {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt((raw ?? "").trim(), 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * Sample active facts for a pass run, enriched with the corroboration count
 * the scoring core ranks by (distinct source sessions per exact triple —
 * the same value recall's corroboration boost uses). Random draw capped at
 * `limit`, matching the contradiction/dedup samplers.
 */
export function samplePromotionCandidatesSqlite(
  db: Database.Database,
  tenantId: string,
  limit: number,
): PromotionCandidate[] {
  const tc = tenantClause(tenantId);
  const rows = db
    .prepare<[string, number], {
      id: string; subject: string; predicate: string; value: string;
      property_slug: string | null; confidence: number;
      source_session_id: string; created_at: string;
    }>(
      `SELECT id, subject, predicate, value, property_slug, confidence,
              source_session_id, created_at FROM facts
       WHERE superseded_by IS NULL AND retired_at IS NULL AND ${tc.sql}
       ORDER BY random() LIMIT ?`,
    )
    .all(tc.param, limit);
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const ph = ids.map(() => "?").join(",");
  const f2tc = tenantClause(tenantId, "f2.tenant_id");
  const corrRows = db
    .prepare<unknown[], { winner_id: string; n: number }>(
      `SELECT f.id AS winner_id, COUNT(DISTINCT f2.source_session_id) AS n
       FROM facts f
       JOIN facts f2
         ON f2.subject = f.subject AND f2.predicate = f.predicate AND f2.value = f.value
        AND f2.superseded_by IS NULL AND f2.retired_at IS NULL
        AND (f2.property_slug IS f.property_slug)
        AND ${f2tc.sql}
       WHERE f.id IN (${ph})
       GROUP BY f.id`,
    )
    .all(f2tc.param, ...(ids as [string, ...string[]]));
  const counts = new Map(corrRows.map((r) => [r.winner_id, r.n]));
  return rows.map((r) => ({
    id: r.id,
    subject: r.subject,
    predicate: r.predicate,
    value: r.value,
    propertySlug: r.property_slug,
    corroborationCount: counts.get(r.id) ?? 1,
    confidence: r.confidence,
    sourceSessionId: r.source_session_id,
    createdAt: r.created_at,
  }));
}

function readJsonl(path: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const obj = JSON.parse(line) as unknown;
      if (obj !== null && typeof obj === "object" && !Array.isArray(obj)) {
        out.push(obj as Record<string, unknown>);
      }
    } catch {
      // One malformed telemetry line must not fail the pass.
    }
  }
  return out;
}

function parseHookFires(path: string, windowMs: number, now: number): HookFireRow[] {
  const cutoff = now - windowMs;
  const out: HookFireRow[] = [];
  for (const r of readJsonl(path)) {
    if (typeof r["conversationId"] !== "string") continue;
    if (typeof r["ts"] === "string" && Number.isFinite(Date.parse(r["ts"])) && Date.parse(r["ts"]) < cutoff) continue;
    const hits = Array.isArray(r["hits"])
      ? (r["hits"] as ReadonlyArray<{ id?: unknown; score?: unknown }>)
          .filter((h): h is { id: string; score: number } => typeof h.id === "string" && typeof h.score === "number")
          .map((h) => ({ id: h.id, score: h.score }))
      : [];
    out.push({
      conversationId: r["conversationId"],
      estTokens: typeof r["estTokens"] === "number" ? r["estTokens"] : -1,
      hits,
    });
  }
  return out;
}

function parseCitations(path: string, windowMs: number, now: number): Array<CitationRow & { ts: string | null }> {
  const cutoff = now - windowMs;
  const out: Array<CitationRow & { ts: string | null }> = [];
  for (const r of readJsonl(path)) {
    const conv = (r["conversation_id"] ?? r["conversationId"]) as unknown;
    const cited = (r["cited_id"] ?? r["citedId"]) as unknown;
    if (typeof conv !== "string" || typeof cited !== "string") continue;
    const ts = typeof r["ts"] === "string" ? r["ts"] : null;
    if (ts !== null && Number.isFinite(Date.parse(ts)) && Date.parse(ts) < cutoff) continue;
    out.push({ conversationId: conv, citedId: cited, ts });
  }
  return out;
}

export interface PromotionTelemetry {
  readonly fires: ReadonlyArray<HookFireRow>;
  readonly citations: ReadonlyArray<CitationRow>;
  readonly signals: PromotionSignals;
}

/**
 * Load windowed telemetry and attribute session-level ids to the session's
 * active facts: a hook hit or citation naming a session credits every active
 * fact sourced from that session; an id naming a fact credits it directly.
 * A missing log file yields empty signals, never an error.
 */
export function loadPromotionTelemetry(
  candidates: ReadonlyArray<PromotionCandidate>,
  opts: {
    readonly hookLogPath: string;
    readonly citationLogPath: string;
    readonly windowDays?: number;
    readonly now?: number;
  },
): PromotionTelemetry {
  const now = opts.now ?? Date.now();
  const windowMs = (opts.windowDays ?? DEFAULT_WINDOW_DAYS) * 24 * 60 * 60 * 1000;
  const fires = parseHookFires(opts.hookLogPath, windowMs, now);
  const citeRows = parseCitations(opts.citationLogPath, windowMs, now);

  const factIds = new Set(candidates.map((c) => c.id));
  const bySession = new Map<string, string[]>();
  for (const c of candidates) {
    if (!bySession.has(c.sourceSessionId)) bySession.set(c.sourceSessionId, []);
    bySession.get(c.sourceSessionId)!.push(c.id);
  }
  const credit = (target: Map<string, number>, id: string): void => {
    if (factIds.has(id)) {
      target.set(id, (target.get(id) ?? 0) + 1);
      return;
    }
    for (const fid of bySession.get(id) ?? []) {
      target.set(fid, (target.get(fid) ?? 0) + 1);
    }
  };
  const retrievalCounts = new Map<string, number>();
  for (const f of fires) {
    const seen = new Set<string>();
    for (const h of f.hits) {
      if (seen.has(h.id)) continue;
      seen.add(h.id);
      credit(retrievalCounts, h.id);
    }
  }
  const citationCounts = new Map<string, number>();
  const everCited = new Set<string>();
  for (const c of citeRows) {
    if (factIds.has(c.citedId)) {
      citationCounts.set(c.citedId, (citationCounts.get(c.citedId) ?? 0) + 1);
      everCited.add(c.citedId);
      continue;
    }
    for (const fid of bySession.get(c.citedId) ?? []) {
      citationCounts.set(fid, (citationCounts.get(fid) ?? 0) + 1);
      everCited.add(fid);
    }
  }
  return {
    fires,
    citations: citeRows.map((c) => ({ conversationId: c.conversationId, citedId: c.citedId })),
    signals: { retrievalCounts, citationCounts, everCited },
  };
}

/** Tenant-derived telemetry paths, mirroring the hook-log / citation-log
 *  resolution (env override for the default team, tenant-isolated otherwise).
 *  No hostnames, IPs, or URLs anywhere — local state paths only. */
export function defaultTelemetryPaths(tenantId: string): { hookLogPath: string; citationLogPath: string } {
  if (tenantId === DEFAULT_TEAM_ID) {
    return {
      hookLogPath: process.env["NLM_HOOK_LOG"] ?? tenantStatePath(tenantId, "hook-log.jsonl"),
      citationLogPath: process.env["NLM_CITATION_LOG"] ?? tenantStatePath(tenantId, "citation-log.jsonl"),
    };
  }
  return {
    hookLogPath: tenantStatePath(tenantId, "hook-log.jsonl"),
    citationLogPath: tenantStatePath(tenantId, "citation-log.jsonl"),
  };
}

export interface PromotionPassOptions {
  readonly tenantId?: string;
  readonly store: SqlitePromotionStore;
  /** Picks the facts to consider this run (the pass itself is stateless). */
  sampleCandidates(limit: number): Promise<ReadonlyArray<PromotionCandidate>>;
  /** Telemetry loader override (tests); default reads the tenant log paths. */
  loadTelemetry?: (candidates: ReadonlyArray<PromotionCandidate>) => Promise<PromotionTelemetry>;
  /** false (report-only) unless explicitly true. */
  readonly apply?: boolean;
  readonly sampleSize?: number;
  readonly maxLines?: number;
  readonly maxBytes?: number;
  readonly windowDays?: number;
  readonly now?: number;
  readonly logger?: (msg: string) => void;
}

/**
 * Run one promotion pass. Pure w.r.t. the given deps: with apply false
 * nothing anywhere is written; with apply true new nominees are recorded
 * and whatever fell out (stale / never-cited / over-cap / fact-inactive)
 * is demoted with a reason, each row kept as its own link.
 */
export async function runPromotionPass(opts: PromotionPassOptions): Promise<PromotionPassReport> {
  const tenantId = opts.tenantId ?? DEFAULT_TEAM_ID;
  const apply = opts.apply === true;
  const sampleSize = opts.sampleSize ?? DEFAULT_SAMPLE_SIZE;
  const maxLines = opts.maxLines ?? MAX_PROMOTION_LINES;
  const maxBytes = opts.maxBytes ?? MAX_PROMOTION_BYTES;
  const now = opts.now ?? Date.now();

  const candidates = await opts.sampleCandidates(sampleSize);
  const telemetry = opts.loadTelemetry
    ? await opts.loadTelemetry(candidates)
    : loadPromotionTelemetry(candidates, {
        ...defaultTelemetryPaths(tenantId),
        ...(opts.windowDays !== undefined ? { windowDays: opts.windowDays } : {}),
        now,
      });
  const { signals } = telemetry;

  const eligible = candidates.filter((c) => isPromotionEligible(c, signals));
  const active = opts.store.listActive(tenantId);
  const activeFactIds = new Set(candidates.map((c) => c.id));
  const activeById = new Map(candidates.map((c) => [c.id, c]));
  const standingById = new Map(active.map((p) => [p.factId, p]));

  // Nominees: eligible candidates not already promoted, greedy under the cap.
  const fresh = eligible.filter((c) => !standingById.has(c.id));
  const scoredFresh: PromotionNominee[] = fresh.map((c) => {
    const retrievals = countIn(signals.retrievalCounts, c.id);
    const citations = countIn(signals.citationCounts, c.id);
    return { ...c, score: scorePromotionCandidate(c, signals), retrievals, citations, reason: promotionReason(c, retrievals, citations) };
  });
  scoredFresh.sort((a, b) =>
    b.score - a.score ||
    b.corroborationCount - a.corroborationCount ||
    (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  // Kept actives: still eligible OR still defensible (grandfathered while
  // they carry a signal); staleness is decided by findDemotions below.
  const demotions = findDemotions(active, activeFactIds, signals, now);
  const demoteIds = new Set(demotions.map((d) => d.factId));

  // Cap across kept actives + fresh nominees, scored uniformly.
  const capEntries: Array<{ factId: string; score: number; line: string }> = [];
  for (const p of active) {
    if (demoteIds.has(p.factId)) continue;
    const c = activeById.get(p.factId);
    capEntries.push({
      factId: p.factId,
      score: p.score,
      line: c ? renderPromotionLine(c) : `- ${p.factId}`,
    });
  }
  for (const n of scoredFresh) {
    capEntries.push({ factId: n.id, score: n.score, line: renderPromotionLine(n) });
  }
  const { kept, dropped } = enforcePromotionCap(capEntries, { maxLines, maxBytes });
  const keptIds = new Set(kept);
  const overCapIds = new Set(dropped.filter((id) => standingById.has(id)));

  const findings: PromotionFinding[] = [];
  const toPromote = scoredFresh.filter((n) => keptIds.has(n.id));

  let usedBytes = 0;
  for (const id of kept) {
    const entry = capEntries.find((e) => e.factId === id)!;
    usedBytes += Buffer.byteLength(entry.line, "utf8");
  }

  if (!apply) {
    for (const n of scoredFresh) {
      findings.push({
        factId: n.id,
        action: keptIds.has(n.id) ? "promote" : "skip",
        score: n.score,
        reason: keptIds.has(n.id) ? n.reason : `${n.reason} — over cap, not nominated`,
        written: false,
      });
    }
    for (const d of demotions) {
      findings.push({ factId: d.factId, action: "demote", score: standingById.get(d.factId)?.score ?? 0, reason: d.reason, written: false });
    }
    for (const id of overCapIds) {
      findings.push({
        factId: id,
        action: "demote",
        score: standingById.get(id)?.score ?? 0,
        reason: "dream-promotion: demoted — over cap, lower score than the kept set",
        written: false,
      });
    }
  } else {
    for (const n of toPromote) {
      try {
        opts.store.promote(tenantId, n);
        findings.push({ factId: n.id, action: "promote", score: n.score, reason: n.reason, written: true });
      } catch (e) {
        findings.push({ factId: n.id, action: "promote", score: n.score, reason: n.reason, written: false, error: e instanceof Error ? e.message : String(e) });
      }
    }
    for (const n of scoredFresh) {
      if (keptIds.has(n.id)) continue;
      findings.push({ factId: n.id, action: "skip", score: n.score, reason: `${n.reason} — over cap, not nominated`, written: false });
    }
    const demoteAll = new Map<string, string>(demotions.map((d) => [d.factId, d.reason]));
    for (const id of overCapIds) {
      if (!demoteAll.has(id)) demoteAll.set(id, "dream-promotion: demoted — over cap, lower score than the kept set");
    }
    for (const [factId, reason] of demoteAll) {
      try {
        opts.store.demote(tenantId, factId, reason);
        findings.push({ factId, action: "demote", score: standingById.get(factId)?.score ?? 0, reason, written: true });
      } catch (e) {
        findings.push({ factId, action: "demote", score: standingById.get(factId)?.score ?? 0, reason, written: false, error: e instanceof Error ? e.message : String(e) });
      }
    }
    for (const p of active) {
      if (keptIds.has(p.factId) && !demoteIds.has(p.factId)) {
        findings.push({ factId: p.factId, action: "keep", score: p.score, reason: "dream-promotion: kept — still under cap with a live signal", written: false });
      }
    }
  }

  let injection: InjectionCost | null = null;
  try {
    injection = injectionCostPerUsefulHit(telemetry.fires, telemetry.citations);
  } catch {
    injection = null;
  }

  return {
    apply,
    sampled: candidates.length,
    eligible: eligible.length,
    nominated: toPromote.length,
    promoted: findings.filter((f) => f.action === "promote" && f.written).length,
    demoted: findings.filter((f) => f.action === "demote" && f.written).length,
    capLines: maxLines,
    capBytes: maxBytes,
    usedLines: kept.length,
    usedBytes,
    injection,
    findings,
  };
}

export interface PromotionPassRegistration {
  /** The scheduler (or any host) that runs periodic passes. */
  readonly host: PromotionPassHost;
  /** SQLite handle for the sampler + promotion store; null on the PG backend (not wired yet). */
  readonly sqliteDb: Database.Database | null;
  readonly tenantId?: string;
  /** Injectable for tests; default process.env. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly logger?: (msg: string) => void;
}

/**
 * The single wiring entry point. If enabled by NLM_DREAM_PROMOTE_PASS,
 * registers the pass on the host; otherwise a no-op (the flag is read once,
 * at registration). Reads NLM_DREAM_PROMOTE_APPLY / _SAMPLE / _MAX_LINES /
 * _MAX_BYTES / _WINDOW_DAYS for run policy. A pass failure is logged, never
 * thrown — dreaming must not break ingestion ticks.
 */
export function registerPromotionPass(reg: PromotionPassRegistration): void {
  const env = reg.env ?? process.env;
  if (!flagEnabled(env[DREAM_PROMOTE_PASS_ENV])) return;

  const log = reg.logger ?? ((msg: string) => console.error(msg));
  if (!reg.sqliteDb) {
    log("[dream] promotion pass enabled but the PG backend is not wired — skipping");
    return;
  }

  const tenantId = reg.tenantId ?? DEFAULT_TEAM_ID;
  const apply = flagEnabled(env[DREAM_PROMOTE_APPLY_ENV]);
  const sampleSize = positiveInt(env[DREAM_PROMOTE_SAMPLE_ENV], DEFAULT_SAMPLE_SIZE);
  const maxLines = positiveInt(env[DREAM_PROMOTE_MAX_LINES_ENV], MAX_PROMOTION_LINES);
  const maxBytes = positiveInt(env[DREAM_PROMOTE_MAX_BYTES_ENV], MAX_PROMOTION_BYTES);
  const windowDays = positiveInt(env[DREAM_PROMOTE_WINDOW_DAYS_ENV], DEFAULT_WINDOW_DAYS);
  const db: Database.Database = reg.sqliteDb;
  const store = new SqlitePromotionStore(db);

  reg.host.registerDreamPass({
    name: "dream-promotion",
    intervalMs: DEFAULT_PASS_INTERVAL_MS,
    run: async () => {
      const report = await runPromotionPass({
        tenantId,
        store,
        apply,
        sampleSize,
        maxLines,
        maxBytes,
        windowDays,
        sampleCandidates: (limit) => Promise.resolve(samplePromotionCandidatesSqlite(db, tenantId, limit)),
        logger: log,
      });
      const inj = report.injection?.tokensPerUsefulHit;
      log(
        `[dream] promotion pass (${apply ? "apply" : "dry-run"}): sampled=${report.sampled}` +
          ` eligible=${report.eligible} nominated=${report.nominated}` +
          ` promoted=${report.promoted} demoted=${report.demoted}` +
          ` used=${report.usedLines} lines/${report.usedBytes}B of ${report.capLines} lines/${report.capBytes}B` +
          ` injection=${inj === null || inj === undefined ? "n/a" : Math.round(inj)} tokens/useful-hit`,
      );
    },
  });
}
