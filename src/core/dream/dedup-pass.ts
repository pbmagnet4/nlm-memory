/**
 * Dedup dream pass (T1610).
 *
 * Background "dreaming" lane: sample active (current, non-retired) facts,
 * propose merges between them with the scoring core (dream/fact-dedup.ts),
 * and — in apply mode — supersede each proposal's loser into its winner.
 * No embeddings, no LLM calls anywhere in this pass; the scoring core is
 * deterministic and conservative by design.
 *
 * Invariants (docs/supersedence.md — "preserve the trail, mark it
 * explicitly"):
 *  - Dry-run by default. Nothing is written unless `apply` is explicitly
 *    true (the scheduler wiring gates it behind NLM_DREAM_DEDUP_APPLY).
 *  - A merged fact is never deleted and rows are never hard-merged. The
 *    loser keeps its row and its provenance; markSuperseded(loser → winner)
 *    marks it out of recall and points at the surviving fact — the fact
 *    analog of mark_supersededer (an explicit successor, unlike the
 *    contradiction pass's retire, which is "wrong, no replacement").
 *  - Every supersede carries a reason leading with the merge class and its
 *    evidence, so the supersedence audit entry alone explains the merge.
 *  - A failed supersede leaves the fact alone and is reported as an error;
 *    sampling another day gets another shot.
 *  - Chains can't be applied twice: the proposal set already excludes
 *    repeat losers, and a fact that lost since sampling simply no longer
 *    appears in the active slice.
 *
 * Scheduler wiring: this module owns the policy (env flags, defaults, the
 * SQLite sampler); the scheduler is a dumb host for periodic passes. The
 * single entry point is registerDedupPass().
 */

import type Database from "better-sqlite3";
import type { FactStore } from "@ports/fact-store.js";
import { DEFAULT_TEAM_ID } from "@core/tenancy/default-team.js";
import { tenantClause } from "@core/tenancy/tenant-clause.js";
import { appendFactSupersedence } from "@core/storage/supersedence-log.js";
import {
  proposeFactMerges,
  type FactDedupFact,
  type FactMergeProposal,
} from "./fact-dedup.js";

/** Enable the scheduled wiring (registerDedupPass). Off unless 1/true. */
export const DREAM_DEDUP_PASS_ENV = "NLM_DREAM_DEDUP_PASS";
/** Mutate (supersede + audit) instead of report-only. Off unless 1/true. */
export const DREAM_DEDUP_APPLY_ENV = "NLM_DREAM_DEDUP_APPLY";
/** Facts considered per run. */
export const DREAM_DEDUP_SAMPLE_ENV = "NLM_DREAM_DEDUP_SAMPLE";

/** Once a day — the pass is a nightly sweep, not a per-tick cost. */
export const DEFAULT_PASS_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_SAMPLE_SIZE = 200;

/** `source` stamped on the fact-supersedence audit entry. */
export const DEDUP_PASS_SOURCE = "dream-dedup-pass";

/** The facts the scoring core proposes over — the sampler's structural view
 *  of an active fact, same style as DreamFact in contradiction-pass.ts.
 *  `propertySlug` carries the assertion context: the scoring core knows only
 *  (subject, predicate, value), so the pass partitions by it (below). */
export type DedupFact = FactDedupFact & { readonly propertySlug: string | null };

/** Assertion-context key; the no-slug (unattributed) group is one context. */
function contextKey(fact: DedupFact): string {
  return fact.propertySlug ?? "";
}

/** Periodic background pass hosted by the scheduler (same shape as the
 *  contradiction pass's DreamPassSpec; the scheduler stays pass-agnostic). */
export interface DedupPassSpec {
  readonly name: string;
  readonly intervalMs: number;
  run(): Promise<void>;
}

export interface DedupPassHost {
  registerDreamPass(pass: DedupPassSpec): void;
}

export interface DedupFinding {
  readonly winnerId: string;
  readonly loserId: string;
  readonly cls: FactMergeProposal["cls"];
  /** Assertion context the merge happened in ("" = unattributed). */
  readonly propertySlug: string;
  /** Why the value folds together + why this fact wins (from the proposal). */
  readonly proposalReason: string;
  /** Full reason recorded on the supersede (audit-facing). */
  readonly reason: string;
  /** True only when apply was set AND the supersede actually happened. */
  readonly superseded: boolean;
  readonly error?: string;
}

export interface DedupPassReport {
  readonly apply: boolean;
  readonly sampled: number;
  readonly proposals: number;
  readonly exact: number;
  readonly restatement: number;
  readonly superseded: number;
  /** Failed supersedes — facts left untouched with an error note. */
  readonly errors: number;
  readonly findings: ReadonlyArray<DedupFinding>;
}

export interface DedupPassOptions {
  readonly tenantId?: string;
  /** Only markSuperseded() is used — the fact-level successor marker. */
  readonly facts: Pick<FactStore, "markSuperseded">;
  /** Picks the facts to consider this run (the pass itself is stateless). */
  sampleFacts(limit: number): Promise<ReadonlyArray<DedupFact>>;
  /** false (report-only) unless explicitly true. */
  readonly apply?: boolean;
  readonly sampleSize?: number;
  /** Supersedence audit log override (tests); default is the tenant-derived path. */
  readonly supersedenceLogPath?: string;
  readonly logger?: (msg: string) => void;
}

function flagEnabled(raw: string | undefined): boolean {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt((raw ?? "").trim(), 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** The proposal's own reason states the merge evidence and the winner
 *  rationale; the supersede reason wraps it with the action and the pass
 *  name, so the audit entry alone explains what happened and why — the
 *  same shape as the contradiction pass's contradictionReason(). */
export function dedupSupersedeReason(proposal: FactMergeProposal): string {
  return `dream-dedup: superseded fact ${proposal.loserId} into ${proposal.winnerId} — ${proposal.reason}`;
}

/**
 * Sample active facts for a pass run, enriched with the corroboration count
 * the scoring core ranks winners by (distinct source sessions per exact
 * triple — the same value recall's corroboration boost uses). Random draw
 * capped at `limit`, matching the contradiction pass sampler.
 */
export function sampleActiveFactsSqlite(
  db: Database.Database,
  tenantId: string,
  limit: number,
): ReadonlyArray<DedupFact> {
  const tc = tenantClause(tenantId);
  const rows = db
    .prepare<[string, number], {
      id: string; subject: string; predicate: string; value: string; created_at: string;
      property_slug: string | null;
    }>(
      `SELECT id, subject, predicate, value, created_at, property_slug FROM facts
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
    createdAt: r.created_at,
    propertySlug: r.property_slug,
    corroborationCount: counts.get(r.id) ?? 1,
  }));
}

/**
 * Run one dedup pass. Pure w.r.t. the given deps: with apply false nothing
 * anywhere is written; with apply true only proposed losers are superseded,
 * each with an audit entry.
 */
export async function runDedupPass(opts: DedupPassOptions): Promise<DedupPassReport> {
  const tenantId = opts.tenantId ?? DEFAULT_TEAM_ID;
  const apply = opts.apply === true;
  const sampleSize = opts.sampleSize ?? DEFAULT_SAMPLE_SIZE;

  const facts = await opts.sampleFacts(sampleSize);
  // Propose per assertion context: fact collapse matches property context as
  // well as subject and predicate (docs/properties.md), and the scoring core
  // is deliberately property-blind. Contexts are visited in slug order so a
  // run is deterministic for a given sample.
  const contexts = new Map<string, DedupFact[]>();
  for (const fact of facts) {
    const key = contextKey(fact);
    if (!contexts.has(key)) contexts.set(key, []);
    contexts.get(key)!.push(fact);
  }
  const proposals: Array<FactMergeProposal & { readonly propertySlug: string }> = [];
  for (const key of [...contexts.keys()].sort()) {
    for (const proposal of proposeFactMerges(contexts.get(key)!)) {
      proposals.push({ ...proposal, propertySlug: key });
    }
  }
  const findings: DedupFinding[] = [];

  for (const proposal of proposals) {
    const reason = dedupSupersedeReason(proposal);
    const base = {
      winnerId: proposal.winnerId,
      loserId: proposal.loserId,
      cls: proposal.cls,
      propertySlug: proposal.propertySlug,
      proposalReason: proposal.reason,
      reason,
    };
    if (!apply) {
      findings.push({ ...base, superseded: false });
      continue;
    }
    try {
      // markSuperseded = the loser's explicit successor: recall-ineligible,
      // row and provenance kept, embedding evicted (supersedence.md: mark
      // explicitly, never erase). appendFactSupersedence records the reason
      // naming this pass — the reconcile-facts / contradiction-pass pattern.
      await opts.facts.markSuperseded(tenantId, proposal.loserId, proposal.winnerId);
      await appendFactSupersedence(
        tenantId,
        { factId: proposal.loserId, reason, source: DEDUP_PASS_SOURCE },
        opts.supersedenceLogPath,
      );
      findings.push({ ...base, superseded: true });
    } catch (e) {
      findings.push({
        ...base,
        superseded: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return {
    apply,
    sampled: facts.length,
    proposals: proposals.length,
    exact: proposals.filter((p) => p.cls === "exact").length,
    restatement: proposals.filter((p) => p.cls === "restatement").length,
    superseded: findings.filter((f) => f.superseded).length,
    errors: findings.filter((f) => f.error !== undefined).length,
    findings,
  };
}

export interface DedupPassRegistration {
  /** The scheduler (or any host) that runs periodic passes. */
  readonly host: DedupPassHost;
  /** SQLite handle for the sampler; null on the PG backend (not wired yet). */
  readonly sqliteDb: Database.Database | null;
  readonly factStore: FactStore | null;
  readonly tenantId?: string;
  /** Injectable for tests; default process.env. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly logger?: (msg: string) => void;
}

/**
 * The single wiring entry point. If enabled by NLM_DREAM_DEDUP_PASS,
 * registers the pass on the host; otherwise a no-op (the flag is read once,
 * at registration). Reads NLM_DREAM_DEDUP_APPLY / _SAMPLE for run policy.
 * A pass failure is logged, never thrown — dreaming must not break
 * ingestion ticks.
 */
export function registerDedupPass(reg: DedupPassRegistration): void {
  const env = reg.env ?? process.env;
  if (!flagEnabled(env[DREAM_DEDUP_PASS_ENV])) return;

  const log = reg.logger ?? ((msg: string) => console.error(msg));
  if (!reg.sqliteDb || !reg.factStore) {
    log("[dream] dedup pass enabled but the PG backend or fact store is not wired — skipping");
    return;
  }

  const tenantId = reg.tenantId ?? DEFAULT_TEAM_ID;
  const apply = flagEnabled(env[DREAM_DEDUP_APPLY_ENV]);
  const sampleSize = positiveInt(env[DREAM_DEDUP_SAMPLE_ENV], DEFAULT_SAMPLE_SIZE);
  const db: Database.Database = reg.sqliteDb;

  reg.host.registerDreamPass({
    name: "dream-dedup",
    intervalMs: DEFAULT_PASS_INTERVAL_MS,
    run: async () => {
      const report = await runDedupPass({
        tenantId,
        facts: reg.factStore!,
        apply,
        sampleSize,
        sampleFacts: (limit) => Promise.resolve(sampleActiveFactsSqlite(db, tenantId, limit)),
        logger: log,
      });
      log(
        `[dream] dedup pass (${apply ? "apply" : "dry-run"}): sampled=${report.sampled}` +
          ` proposals=${report.proposals} exact=${report.exact} restatement=${report.restatement}` +
          ` superseded=${report.superseded} errors=${report.errors}`,
      );
    },
  });
}
