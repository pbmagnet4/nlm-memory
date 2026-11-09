/**
 * Contradiction dream pass (T1609).
 *
 * Background "dreaming" lane: sample active (current, non-retired) facts,
 * re-read each fact's source session transcript, and ask the dream judge
 * (dream/judge.ts) whether the transcript still supports the fact. A fact
 * the source transcript contradicts is retired with an audit reason quoting
 * the transcript evidence; everything else is left untouched.
 *
 * Invariants (docs/supersedence.md — "preserve the trail, mark it
 * explicitly"):
 *  - Dry-run by default. Nothing is written unless `apply` is explicitly
 *    true (the scheduler wiring gates it behind NLM_DREAM_CONTRADICTION_APPLY).
 *  - Contradictions are never deleted. The fact row survives; the retire
 *    path (factStore.retire, the fact-level supersedence marker for "wrong,
 *    no replacement" — supersede itself requires a successor fact) drops it
 *    from recall, and appendFactSupersedence records the reason citing the
 *    transcript evidence in the supersedence audit log, matching the
 *    reconcile-facts precedent.
 *  - Unverifiable is flagged in the report and NEVER touched — same rule as
 *    the judge's "doubt is unverifiable". A fact whose transcript is gone
 *    (no body) is unverifiable by construction: no judge call, no write.
 *  - A contradicted verdict retires only with a non-empty evidence quote
 *    that occurs in the judged excerpt; anything else is downgraded to
 *    unverifiable — a hallucinated contradiction must never retire a fact.
 *  - A failed judge call (DreamJudgeError / transport) leaves the fact
 *    alone; sampling another day gets another shot. A failed audit write
 *    after a retire is reported as an error, not counted as superseded.
 *  - A thrown transcript-store fetch is a judge-error, never
 *    no-transcript: a transient failure must not pose as a missing session.
 *  - Judge calls run through a worker pool capped at `maxInFlight`
 *    (default 4, the oMLX gateway's concurrency) — never one per fact at
 *    once across a large sample.
 *
 * Scheduler wiring: this module owns the pass logic; the run policy
 * (enabled, cadence, sample, in-flight, apply mode) is resolved through the
 * dreaming settings module (dream/settings.ts) — the single home of the
 * NLM_DREAM_* names, their parsing and their defaults — instead of reading
 * process.env directly. The scheduler is a dumb host for periodic passes.
 * The single entry point is registerContradictionPass().
 */

import type Database from "better-sqlite3";
import type { LLMClient } from "@ports/llm-client.js";
import type { FactStore } from "@ports/fact-store.js";
import { DEFAULT_TEAM_ID } from "@core/tenancy/default-team.js";
import { tenantClause } from "@core/tenancy/tenant-clause.js";
import { appendFactSupersedenceOrThrow } from "@core/storage/supersedence-log.js";
import { judgeDreamFact, type DreamVerdict } from "./judge.js";
import {
  DEFAULT_CONTRADICTION_SAMPLE_SIZE,
  DEFAULT_MAX_IN_FLIGHT,
  dreamSettingsFromEnv,
  recordLastRun,
  type DreamSettings,
} from "./settings.js";

/** `source` stamped on the fact-supersedence audit entry. */
export const CONTRADICTION_PASS_SOURCE = "dream-contradiction-pass";

// The run defaults live in the settings module; re-exported here so the
// pass's public surface keeps naming the values it actually runs with.
export { DEFAULT_MAX_IN_FLIGHT };

const DEFAULT_EXCERPT_CHARS = 4_000;

/** The slice of a fact the pass needs — deliberately narrower than a full
 *  Fact so the sampler reads only the columns it uses. */
export interface DreamFact {
  readonly id: string;
  readonly subject: string;
  readonly predicate: string;
  readonly value: string;
  readonly sourceSessionId: string;
  readonly sourceQuote: string | null;
  readonly createdAt: string;
}

/** Reads one session's transcript body; null when the session is gone.
 *  Structural subset of SqliteSessionStore/PgSessionStore.getById. */
export interface TranscriptSource {
  getById(tenantId: string, sessionId: string): Promise<{ readonly body: string } | null>;
}

/** Periodic background pass hosted by the scheduler. */
export interface DreamPassSpec {
  readonly name: string;
  readonly intervalMs: number;
  run(): Promise<void>;
}

export interface DreamPassHost {
  registerDreamPass(pass: DreamPassSpec): void;
}

export type ContradictionOutcome =
  | DreamVerdict
  /** Source session has no transcript body — unverifiable without a judge call. */
  | "no-transcript"
  /** Judge call failed (bad reply or transport error). Never mutates. */
  | "judge-error";

export interface ContradictionFinding {
  readonly factId: string;
  readonly subject: string;
  readonly predicate: string;
  readonly value: string;
  readonly sourceSessionId: string;
  readonly outcome: ContradictionOutcome;
  /** Model verdict; null for no-transcript / judge-error. */
  readonly verdict: DreamVerdict | null;
  readonly evidenceQuote: string;
  readonly model?: string;
  /** True only when apply was set AND the retire actually happened. */
  readonly superseded: boolean;
  /** Audit reason recorded (apply mode, contradicted facts). */
  readonly reason?: string;
  readonly error?: string;
}

export interface ContradictionPassReport {
  readonly apply: boolean;
  readonly sampled: number;
  /** Facts that reached a model verdict (contradicted + still-true + unverifiable). */
  readonly judged: number;
  readonly contradicted: number;
  readonly superseded: number;
  readonly stillTrue: number;
  readonly unverifiable: number;
  readonly noTranscript: number;
  /** Failed judge calls, failed retire/audit writes, and contradicted
   *  verdicts downgraded for bad evidence — each carries an error note. */
  readonly errors: number;
  /** Peak concurrent in-flight judge calls observed (bounded by maxInFlight). */
  readonly peakInFlight: number;
  readonly findings: ReadonlyArray<ContradictionFinding>;
}

export interface ContradictionPassOptions {
  readonly tenantId?: string;
  /** Only retire() is used — the fact-level supersedence marker path. */
  readonly facts: Pick<FactStore, "retire">;
  readonly transcripts: TranscriptSource;
  readonly llm: LLMClient;
  /** Picks the facts to audit this run (the pass itself is stateless). */
  sampleFacts(limit: number): Promise<ReadonlyArray<DreamFact>>;
  /** false (report-only) unless explicitly true. */
  readonly apply?: boolean;
  readonly sampleSize?: number;
  readonly maxInFlight?: number;
  readonly model?: string;
  readonly excerptChars?: number;
  /** Supersedence audit log override (tests); default is the tenant-derived path. */
  readonly supersedenceLogPath?: string;
  readonly logger?: (msg: string) => void;
}

/** Fact text handed to the judge: subject/predicate give the value its scope. */
export function factJudgementText(fact: DreamFact): string {
  return `${fact.subject} ${fact.predicate}: ${fact.value}`;
}

/**
 * Transcript window the judge sees. When the fact carries a source quote we
 * can locate in the body, center the window on it (the contradiction, if
 * any, lives near the fact's own evidence); otherwise the opening excerpt.
 */
export function buildTranscriptExcerpt(
  body: string,
  sourceQuote: string | null | undefined,
  maxChars: number = DEFAULT_EXCERPT_CHARS,
): string {
  const text = body.trim();
  if (text === "") return "";
  if (text.length <= maxChars) return text;
  const quote = (sourceQuote ?? "").trim();
  if (quote.length > 0) {
    const at = body.indexOf(quote);
    if (at >= 0) {
      const start = Math.max(0, at - Math.floor(maxChars / 2));
      return body.slice(start, start + maxChars);
    }
  }
  return body.slice(0, maxChars);
}

/** The judge's verdict rendered into the audit reason: the evidence quote
 *  leads, so the log entry alone explains the supersede. */
export function contradictionReason(fact: DreamFact, evidenceQuote: string, model: string): string {
  const quote = evidenceQuote.trim() === "" ? "(no quote)" : `"${evidenceQuote.trim()}"`;
  return `dream-contradiction: source session ${fact.sourceSessionId} transcript contradicts "${fact.subject} ${fact.predicate}: ${fact.value}" — evidence ${quote} (judge ${model})`;
}

/**
 * Sample active facts for a pass run. Random draw, not oldest-first:
 * unverifiable facts are never touched, so a strict ordering would let them
 * occupy every slot of every run and starve the rest of the store.
 */
export function sampleActiveFactsSqlite(
  db: Database.Database,
  tenantId: string,
  limit: number,
): ReadonlyArray<DreamFact> {
  const tc = tenantClause(tenantId);
  const rows = db
    .prepare<[string, number], {
      id: string; subject: string; predicate: string; value: string;
      source_session_id: string; source_quote: string | null; created_at: string;
    }>(
      `SELECT id, subject, predicate, value, source_session_id, source_quote, created_at FROM facts
       WHERE superseded_by IS NULL AND retired_at IS NULL AND ${tc.sql}
       ORDER BY random() LIMIT ?`,
    )
    .all(tc.param, limit);
  return rows.map((r) => ({
    id: r.id,
    subject: r.subject,
    predicate: r.predicate,
    value: r.value,
    sourceSessionId: r.source_session_id,
    sourceQuote: r.source_quote,
    createdAt: r.created_at,
  }));
}

/** Bounded worker pool; returns the peak in-flight count it observed. */
async function runPool<T>(
  items: ReadonlyArray<T>,
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<number> {
  let next = 0;
  let inFlight = 0;
  let peak = 0;
  const lanes = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: lanes }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        try {
          await worker(items[i]!);
        } finally {
          inFlight -= 1;
        }
      }
    }),
  );
  return peak;
}

/**
 * Run one contradiction pass. Pure w.r.t. the given deps: with apply false
 * nothing anywhere is written; with apply true only contradicted facts are
 * retired, each with an audit entry.
 */
export async function runContradictionPass(
  opts: ContradictionPassOptions,
): Promise<ContradictionPassReport> {
  const tenantId = opts.tenantId ?? DEFAULT_TEAM_ID;
  const apply = opts.apply === true;
  const sampleSize = opts.sampleSize ?? DEFAULT_CONTRADICTION_SAMPLE_SIZE;
  const maxInFlight = Math.max(1, opts.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT);
  const excerptChars = opts.excerptChars ?? DEFAULT_EXCERPT_CHARS;

  const facts = await opts.sampleFacts(sampleSize);
  const findings: ContradictionFinding[] = [];

  const peakInFlight = await runPool(facts, maxInFlight, async (fact) => {
    const base = {
      factId: fact.id,
      subject: fact.subject,
      predicate: fact.predicate,
      value: fact.value,
      sourceSessionId: fact.sourceSessionId,
    };
    // A null session (or an empty body) means the transcript is genuinely
    // gone — unverifiable without a judge call. A thrown store error is a
    // different case: record it as an error so a transient failure is never
    // mistaken for a missing transcript.
    let body: string;
    try {
      body = (await opts.transcripts.getById(tenantId, fact.sourceSessionId))?.body ?? "";
    } catch (e) {
      findings.push({
        ...base,
        outcome: "judge-error",
        verdict: null,
        evidenceQuote: "",
        superseded: false,
        error: `transcript store fetch failed: ${e instanceof Error ? e.message : String(e)}`,
      });
      return;
    }
    const excerpt = buildTranscriptExcerpt(body, fact.sourceQuote, excerptChars);
    if (excerpt === "") {
      findings.push({ ...base, outcome: "no-transcript", verdict: null, evidenceQuote: "", superseded: false });
      return;
    }
    let verdict: DreamVerdict;
    let evidenceQuote: string;
    let model: string;
    try {
      const judgement = await judgeDreamFact(
        { llm: opts.llm, ...(opts.model !== undefined ? { model: opts.model } : {}) },
        factJudgementText(fact),
        excerpt,
      );
      verdict = judgement.verdict;
      evidenceQuote = judgement.evidenceQuote;
      model = judgement.model;
    } catch (e) {
      findings.push({
        ...base,
        outcome: "judge-error",
        verdict: null,
        evidenceQuote: "",
        superseded: false,
        error: e instanceof Error ? e.message : String(e),
      });
      return;
    }

    if (verdict !== "contradicted") {
      findings.push({ ...base, outcome: verdict, verdict, evidenceQuote, model, superseded: false });
      return;
    }

    // A contradicted verdict is only actionable with a non-empty evidence
    // quote that actually occurs in the judged excerpt — otherwise the model
    // hallucinated the contradiction and retiring would drop a good fact on
    // a bogus reason. Downgrade to unverifiable (never touched) with an
    // error note instead.
    const quote = evidenceQuote.trim();
    if (quote === "" || !excerpt.includes(quote)) {
      findings.push({
        ...base,
        outcome: "unverifiable",
        verdict: "unverifiable",
        evidenceQuote,
        model,
        superseded: false,
        error:
          quote === ""
            ? "contradicted verdict carried no evidence quote — downgraded to unverifiable"
            : "contradicted verdict evidence quote not found in the judged excerpt — downgraded to unverifiable",
      });
      return;
    }

    const reason = contradictionReason(fact, evidenceQuote, model);
    const finding = {
      ...base,
      outcome: "contradicted" as const,
      verdict,
      evidenceQuote,
      model,
      reason,
    };
    if (!apply) {
      findings.push({ ...finding, superseded: false });
      return;
    }
    // Retire = the fact's superseded lane: recall-ineligible, row kept,
    // embedding evicted (supersedence.md: mark explicitly, never erase).
    try {
      await opts.facts.retire(tenantId, fact.id);
    } catch (e) {
      findings.push({
        ...finding,
        superseded: false,
        error: `retire failed: ${e instanceof Error ? e.message : String(e)}`,
      });
      return;
    }
    // The audit append throws (unlike the telemetry variant) so a failed
    // write lands in the report errors instead of silently leaving a
    // retired fact with no audit entry.
    try {
      await appendFactSupersedenceOrThrow(
        tenantId,
        { factId: fact.id, reason, source: CONTRADICTION_PASS_SOURCE },
        opts.supersedenceLogPath,
      );
    } catch (e) {
      findings.push({
        ...finding,
        superseded: false,
        error: `retired but audit write failed: ${e instanceof Error ? e.message : String(e)}`,
      });
      return;
    }
    findings.push({ ...finding, superseded: true });
  });

  const count = (o: ContradictionOutcome) => findings.filter((f) => f.outcome === o).length;
  return {
    apply,
    sampled: facts.length,
    judged: count("still-true") + count("contradicted") + count("unverifiable"),
    contradicted: count("contradicted"),
    superseded: findings.filter((f) => f.superseded).length,
    stillTrue: count("still-true"),
    unverifiable: count("unverifiable"),
    noTranscript: count("no-transcript"),
    errors: findings.filter((f) => f.error !== undefined).length,
    peakInFlight,
    findings,
  };
}

export interface ContradictionPassRegistration {
  /** The scheduler (or any host) that runs periodic passes. */
  readonly host: DreamPassHost;
  /** SQLite handle for the sampler; null on the PG backend (not wired yet). */
  readonly sqliteDb: Database.Database | null;
  readonly factStore: FactStore | null;
  readonly transcripts: TranscriptSource;
  readonly llm: LLMClient;
  readonly tenantId?: string;
  /**
   * Env source used to seed the settings snapshot consulted at
   * registration; default — the settings module resolves it from
   * process.env through its own seed rules, this module never reads
   * process.env itself. Injectable for tests.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly model?: string;
  readonly logger?: (msg: string) => void;
}

/**
 * Resolve the settings snapshot this registration consults, through the
 * settings module's own seed rules — the single home of the NLM_DREAM_*
 * names, their parsing and their defaults (this module owns no env
 * parsing). The env source is re-read at registration exactly as the
 * pre-settings contract did, which the scheduler wiring relies on; hosts
 * that drive the settings module themselves pass no env and seed from
 * process.env the same way.
 */
function resolvePassSettings(
  reg: Pick<ContradictionPassRegistration, "env">,
): DreamSettings {
  return dreamSettingsFromEnv(reg.env ?? process.env);
}

/**
 * The single wiring entry point. Registers the pass when the settings
 * module says the contradiction pass is enabled (seeded from
 * NLM_DREAM_CONTRADICTION_PASS; the flag is read once, at registration);
 * otherwise a no-op. Cadence, sample size, in-flight cap and the dry-run/
 * apply mode all come from the same settings snapshot
 * (dream/settings.ts) — this module owns no env parsing or defaults.
 * Every completed run logs its one-line summary and records it in the
 * settings module's last-run registry. A pass failure is logged, never
 * thrown — dreaming must not break ingestion ticks.
 */
export function registerContradictionPass(reg: ContradictionPassRegistration): void {
  const settings = resolvePassSettings(reg);
  const pass = settings.contradiction;
  if (!pass.enabled) return;

  const log = reg.logger ?? ((msg: string) => console.error(msg));
  if (!reg.sqliteDb || !reg.factStore) {
    log("[dream] contradiction pass enabled but the PG backend or fact store is not wired — skipping");
    return;
  }

  const tenantId = reg.tenantId ?? DEFAULT_TEAM_ID;
  const apply = pass.applyMode === "apply";
  const sampleSize = pass.sampleSize;
  const maxInFlight = pass.maxInFlight;
  const db: Database.Database = reg.sqliteDb;

  reg.host.registerDreamPass({
    name: "dream-contradiction",
    intervalMs: pass.cadenceMs,
    run: async () => {
      const report = await runContradictionPass({
        tenantId,
        facts: reg.factStore!,
        transcripts: reg.transcripts,
        llm: reg.llm,
        ...(reg.model !== undefined ? { model: reg.model } : {}),
        apply,
        sampleSize,
        maxInFlight,
        sampleFacts: (limit) => Promise.resolve(sampleActiveFactsSqlite(db, tenantId, limit)),
        logger: log,
      });
      const summary =
        `[dream] contradiction pass (${apply ? "apply" : "dry-run"}): sampled=${report.sampled}` +
        ` contradicted=${report.contradicted} superseded=${report.superseded}` +
        ` unverifiable=${report.unverifiable} no-transcript=${report.noTranscript} errors=${report.errors}`;
      log(summary);
      recordLastRun("contradiction", {
        mode: apply ? "apply" : "dry-run",
        summary,
        sampled: report.sampled,
        contradicted: report.contradicted,
        superseded: report.superseded,
        unverifiable: report.unverifiable,
        noTranscript: report.noTranscript,
        errors: report.errors,
      });
    },
  });
}
