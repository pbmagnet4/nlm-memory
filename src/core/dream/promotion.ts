/**
 * Promotion scoring core (T1611). Pure functions the promotion dream pass
 * ranks facts with. No LLM calls, no DB access, no I/O — deterministic and
 * unit-testable on plain inputs.
 *
 * A promotion nominates a fact for the pointer block's "Known facts" section
 * (hook/pointer-block.ts). The pass NOMINATES capped candidates for that
 * injection path; it never rewires hook injection itself — the hook keeps
 * composing from live recall, and promotions are the dream lane's capped,
 * evidence-backed suggestion set.
 *
 * Value model — a fact is worth injecting when it is:
 *  - corroborated: asserted across >= minCorroboration distinct sessions
 *    (MIN_CORROBORATION by default — the same bar related-facts.ts demands
 *    before a fact counts as "known", and the bar the dream settings lower
 *    may move);
 *  - recently retrieved: its id — or its source session's id — showed up in
 *    recent hook fires (the agent keeps pulling it);
 *  - cited: the agent actually referenced it (citation log).
 * Eligibility is corroborated AND (retrieved OR cited): a corroborated fact
 * nobody pulls is reference material, not injection material, and promoting
 * it just burns the injection budget the eval harness measures
 * (eval/dream-metrics.ts injectionCostPerUsefulHit).
 *
 * Score (monotonic in every signal, ties broken deterministically):
 *   2 * corroboration + 3 * windowRetrievals + 5 * windowCitations,
 * capped per signal so one viral fact cannot eat the whole budget. Sort order
 * is (score DESC, corroboration DESC, createdAt ASC, id ASC).
 *
 * Cap: the injected promotion set is bounded by MAX_PROMOTION_LINES lines and
 * MAX_PROMOTION_BYTES bytes (200 lines / 25KB — the standing practice for
 * kept-in-context MEMORY headers). Sizes are measured on the exact rendered
 * line the pointer block would inject (renderPromotionLine mirrors the
 * Known-facts line construction in pointer-block.ts; a unit test pins them
 * equal so the two cannot drift apart silently).
 *
 * Demotion (leaving a link behind): a promotion row is never deleted. It is
 * demoted when its fact leaves the active set (superseded / retired / gone),
 * when it goes stale (no retrieval and no citation in the telemetry window
 * and older than STALE_AFTER_DAYS), when it was never cited at all
 * (lifetime citations zero and older than NEVER_CITED_GRACE_DAYS), or when
 * the active set no longer fits under the cap (lowest scores fall off).
 */

export const MIN_CORROBORATION = 2;
export const MIN_CONFIDENCE = 0.7;
/** Hard cap on the injected promotion set: 200 lines / 25KB. */
export const MAX_PROMOTION_LINES = 200;
export const MAX_PROMOTION_BYTES = 25 * 1024;

/** Score weights — citations dominate: a cited fact proved useful. */
export const WEIGHT_CORROBORATION = 2;
export const WEIGHT_RETRIEVAL = 3;
export const WEIGHT_CITATION = 5;

/** Per-signal caps so one viral fact cannot eat the whole budget. */
export const SCORE_CAP_CORROBORATION = 10;
export const SCORE_CAP_RETRIEVAL = 10;
export const SCORE_CAP_CITATION = 5;

/** Active promotion with no window signal this old is stale. */
export const STALE_AFTER_DAYS = 30;
/** A promotion never cited at all gets this long to prove itself. */
export const NEVER_CITED_GRACE_DAYS = 14;

/** The slice of a fact the scorer needs — same style as DreamFact in
 *  contradiction-pass.ts and DedupFact in dedup-pass.ts. */
export interface PromotionCandidate {
  readonly id: string;
  readonly subject: string;
  readonly predicate: string;
  readonly value: string;
  readonly propertySlug: string | null;
  readonly corroborationCount: number;
  readonly confidence: number;
  readonly sourceSessionId: string;
  readonly createdAt: string;
}

/** Windowed telemetry, keyed by fact id. The pass builds these from the
 *  hook/citation logs (attributing session-level ids to the session's
 *  active facts); tests hand them in directly. */
export interface PromotionSignals {
  /** Fires in the window that surfaced the fact (directly or via its source session). */
  readonly retrievalCounts: ReadonlyMap<string, number>;
  /** Citations in the window. */
  readonly citationCounts: ReadonlyMap<string, number>;
  /** Fact ids cited at least once over the log's lifetime (grace rule). */
  readonly everCited: ReadonlySet<string>;
}

export interface PromotionNominee extends PromotionCandidate {
  readonly score: number;
  readonly retrievals: number;
  readonly citations: number;
  /** Why this fact earned injection — the audit-facing evidence line. */
  readonly reason: string;
}

/** Currently-promoted standing the pass read back from the table. */
export interface PromotionStanding {
  readonly factId: string;
  readonly promotedAt: string;
  readonly score: number;
}

export interface DemotionDecision {
  readonly factId: string;
  readonly reason: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function countIn(m: ReadonlyMap<string, number>, key: string): number {
  return m.get(key) ?? 0;
}

export function scorePromotionCandidate(
  c: PromotionCandidate,
  signals: PromotionSignals,
): number {
  const corr = Math.max(0, Math.min(c.corroborationCount, SCORE_CAP_CORROBORATION));
  const retr = Math.max(0, Math.min(countIn(signals.retrievalCounts, c.id), SCORE_CAP_RETRIEVAL));
  const cite = Math.max(0, Math.min(countIn(signals.citationCounts, c.id), SCORE_CAP_CITATION));
  return WEIGHT_CORROBORATION * corr + WEIGHT_RETRIEVAL * retr + WEIGHT_CITATION * cite;
}

function tripleBlank(c: PromotionCandidate): boolean {
  return c.subject.trim() === "" || c.predicate.trim() === "" || c.value.trim() === "";
}

/** Corroborated AND (retrieved OR cited in the window). Confidence and
 *  corroboration floors mirror related-facts.ts so the dream lane cannot
 *  nominate what live recall would refuse to inject. The corroboration floor
 *  is the dream setting's to raise or lower (T1729); MIN_CORROBORATION is the
 *  default it falls back to. */
export function isPromotionEligible(
  c: PromotionCandidate,
  signals: PromotionSignals,
  minCorroboration: number = MIN_CORROBORATION,
): boolean {
  if (tripleBlank(c)) return false;
  if (c.confidence < MIN_CONFIDENCE) return false;
  if (c.corroborationCount < minCorroboration) return false;
  return countIn(signals.retrievalCounts, c.id) > 0 || countIn(signals.citationCounts, c.id) > 0;
}

export function promotionReason(c: PromotionCandidate, retrievals: number, citations: number): string {
  return (
    `dream-promotion: corroborated across ${c.corroborationCount} sessions, ` +
    `retrieved in ${retrievals} recent fires, cited ${citations} times — ` +
    `"${c.subject} ${c.predicate}: ${c.value}"`
  );
}

/** The exact line the pointer block would inject for this fact. Mirrors the
 *  Known-facts line construction in hook/pointer-block.ts (property tag,
 *  triple, corroboration tag) — pinned equal by unit test. */
export function renderPromotionLine(c: Pick<PromotionCandidate, "propertySlug" | "subject" | "predicate" | "value" | "corroborationCount">): string {
  const tag = c.corroborationCount > 1 ? ` [${c.corroborationCount} sessions]` : "";
  const prop = c.propertySlug ? `[${c.propertySlug}] ` : "";
  return `- ${prop}${c.subject} ${c.predicate}: ${c.value}${tag}`;
}

export function promotionLineBytes(line: string): number {
  return Buffer.byteLength(line, "utf8");
}

/**
 * Rank eligible candidates by score and take the greedy prefix that fits
 * under BOTH caps (lines and bytes). Sort is fully deterministic:
 * score DESC, corroboration DESC, createdAt ASC, id ASC.
 */
export function selectPromotions(
  candidates: ReadonlyArray<PromotionCandidate>,
  signals: PromotionSignals,
  opts: { readonly maxLines?: number; readonly maxBytes?: number } = {},
): PromotionNominee[] {
  const maxLines = opts.maxLines ?? MAX_PROMOTION_LINES;
  const maxBytes = opts.maxBytes ?? MAX_PROMOTION_BYTES;
  const scored: PromotionNominee[] = [];
  for (const c of candidates) {
    if (!isPromotionEligible(c, signals)) continue;
    const retrievals = countIn(signals.retrievalCounts, c.id);
    const citations = countIn(signals.citationCounts, c.id);
    scored.push({ ...c, score: scorePromotionCandidate(c, signals), retrievals, citations, reason: promotionReason(c, retrievals, citations) });
  }
  scored.sort((a, b) =>
    b.score - a.score ||
    b.corroborationCount - a.corroborationCount ||
    (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const kept: PromotionNominee[] = [];
  let bytes = 0;
  for (const n of scored) {
    if (kept.length + 1 > maxLines) break;
    const lineBytes = promotionLineBytes(renderPromotionLine(n));
    if (bytes + lineBytes > maxBytes) continue;
    kept.push(n);
    bytes += lineBytes;
  }
  return kept;
}

export function promotionSetBytes(
  lines: ReadonlyArray<{ readonly line: string }>,
): number {
  return lines.reduce((sum, l) => sum + promotionLineBytes(l.line), 0);
}

/**
 * Decide which active promotions lose their slot. Never deletes anything —
 * each decision becomes a demoted_at + demote_reason stamp on the kept row
 * (the link behind). Reasons, in check order:
 *  - fact-inactive: the fact left the active set (superseded / retired / gone).
 *  - stale: no window retrieval, no window citation, older than staleAfterDays.
 *  - never-cited: zero lifetime citations, older than neverCitedGraceDays.
 */
export function findDemotions(
  active: ReadonlyArray<PromotionStanding>,
  activeFactIds: ReadonlySet<string>,
  signals: PromotionSignals,
  now: number = Date.now(),
  opts: { readonly staleAfterDays?: number; readonly neverCitedGraceDays?: number } = {},
): DemotionDecision[] {
  const staleAfterDays = opts.staleAfterDays ?? STALE_AFTER_DAYS;
  const graceDays = opts.neverCitedGraceDays ?? NEVER_CITED_GRACE_DAYS;
  const out: DemotionDecision[] = [];
  for (const p of active) {
    if (!activeFactIds.has(p.factId)) {
      out.push({ factId: p.factId, reason: "dream-promotion: demoted — fact left the active set (superseded, retired, or gone)" });
      continue;
    }
    const ageDays = (now - Date.parse(p.promotedAt)) / DAY_MS;
    if (!Number.isFinite(ageDays)) continue;
    const retr = countIn(signals.retrievalCounts, p.factId);
    const cite = countIn(signals.citationCounts, p.factId);
    if (retr === 0 && cite === 0 && ageDays > staleAfterDays) {
      out.push({ factId: p.factId, reason: `dream-promotion: demoted — stale, no retrieval or citation in the window after ${Math.floor(ageDays)} days promoted` });
      continue;
    }
    if (!signals.everCited.has(p.factId) && cite === 0 && ageDays > graceDays) {
      out.push({ factId: p.factId, reason: `dream-promotion: demoted — never cited after ${Math.floor(ageDays)} days promoted` });
    }
  }
  return out;
}

/**
 * Enforce the cap across the union of kept actives and new nominees: score
 * everything, keep the greedy prefix that fits, report the fact ids that
 * fall off. Callers demote the dropped actives (reason over-cap) and simply
 * skip the dropped nominees. Sizes ride on the rendered lines so the cap
 * accounts exactly what injection would carry.
 */
export function enforcePromotionCap(
  entries: ReadonlyArray<{ readonly factId: string; readonly score: number; readonly line: string }>,
  opts: { readonly maxLines?: number; readonly maxBytes?: number } = {},
): { readonly kept: ReadonlyArray<string>; readonly dropped: ReadonlyArray<string> } {
  const maxLines = opts.maxLines ?? MAX_PROMOTION_LINES;
  const maxBytes = opts.maxBytes ?? MAX_PROMOTION_BYTES;
  const sorted = [...entries].sort((a, b) =>
    b.score - a.score || (a.factId < b.factId ? -1 : a.factId > b.factId ? 1 : 0),
  );
  const kept: string[] = [];
  const dropped: string[] = [];
  let bytes = 0;
  for (const e of sorted) {
    const lineBytes = promotionLineBytes(e.line);
    if (kept.length + 1 > maxLines || bytes + lineBytes > maxBytes) {
      dropped.push(e.factId);
      continue;
    }
    kept.push(e.factId);
    bytes += lineBytes;
  }
  return { kept, dropped };
}
