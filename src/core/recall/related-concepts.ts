/**
 * pickRelatedConcepts — recall-time helper that selects learner-concept rows
 * for the enrollments bound to the top recall hits' workstreams.
 *
 * Mirrors pickRelatedFacts (Spec G.2) in structure and failure posture:
 *
 * Algorithm:
 *   1. Take the top-N hit ids, resolve their workstream bindings in one
 *      batched lookup, dedupe non-null.
 *   2. Fetch active enrollments bound to those workstreams.
 *   3. Per enrollment, derive concept summaries from recorded events.
 *   4. Sort by status rank (practicing 0, exposed 1, demonstrated 2,
 *      retained 3 — what needs work surfaces first), then concept, take limit.
 *
 * Fail-open: any failure returns [] so the pointer block degrades to the
 * session/facts format. This is a quality enhancement; never let it block
 * recall. Limit tunable via NLM_HOOK_CONCEPT_LIMIT (default 5).
 */

import type { LearnerStore } from "@ports/learner-store.js";
import type { SessionStore } from "@ports/session-store.js";
import type { RecallHit, RelatedConcept } from "@shared/types.js";
import { summarizeConcepts } from "@core/learner/summary.js";

const DEFAULT_CONCEPT_LIMIT = 5;
const TOP_HITS_FOR_WS_SCAN = 5;

export interface PickRelatedConceptsDeps {
  readonly learners: LearnerStore;
  readonly sessions: Pick<SessionStore, "getWorkstreamIds">;
}

export interface PickRelatedConceptsOptions {
  readonly limit?: number;
}

function readLimit(fallback: number): number {
  const raw = process.env["NLM_HOOK_CONCEPT_LIMIT"];
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

const STATUS_RANK: Record<RelatedConcept["status"], number> = {
  practicing: 0,
  exposed: 1,
  demonstrated: 2,
  retained: 3,
};

export async function pickRelatedConcepts(
  tenantId: string,
  hits: ReadonlyArray<RecallHit>,
  deps: PickRelatedConceptsDeps,
  opts: PickRelatedConceptsOptions = {},
): Promise<RelatedConcept[]> {
  if (hits.length === 0) return [];
  try {
    const topIds = hits.slice(0, TOP_HITS_FOR_WS_SCAN).map((h) => h.id);
    const wsBySession = await deps.sessions.getWorkstreamIds(tenantId, topIds);
    const wsIds = [...new Set(topIds.map((id) => wsBySession.get(id)).filter((w): w is string => w !== null && w !== undefined))];
    if (wsIds.length === 0) return [];

    const enrollments = (await deps.learners.listEnrollmentsByWorkstreams(tenantId, wsIds)).filter(
      (e) => e.status === "active",
    );
    if (enrollments.length === 0) return [];

    const rows: RelatedConcept[] = [];
    for (const enrollment of enrollments) {
      const events = await deps.learners.listEvents(tenantId, enrollment.learnerId, enrollment.courseId);
      const last = events.length > 0 ? events[events.length - 1]! : null;
      for (const c of summarizeConcepts(events)) {
        rows.push({
          concept: c.concept,
          status: c.status,
          attemptCount: c.attemptCount,
          nextStep: last ? last.nextStep : null,
        });
      }
    }
    rows.sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || (a.concept < b.concept ? -1 : 1));
    return rows.slice(0, opts.limit ?? readLimit(DEFAULT_CONCEPT_LIMIT));
  } catch {
    return [];
  }
}
