/**
 * Outcome rollup core (#352 phase 3 / Tier-B).
 *
 * Answers "did this session's decision hold up?" using only a later,
 * independent event as evidence — never the agent's or an LLM's opinion of
 * its own work. No LLM call anywhere in this module.
 *
 * Evidence precedence (sign-off amendment order — first match wins):
 *   1. Tier-A: a `signals` row correlated to the session. Strongest evidence;
 *      wins over every heuristic below regardless of what they'd conclude.
 *   2. Supersession: session status superseded/replaced, or a
 *      supersedes/replaces edge pointing at this session -> "overturned"
 *      (high). Un-superseded 14+ days after `endedAt` -> "held" (medium).
 *   3. Continuation: an inbound `continues` edge -> "built-upon" (medium).
 *   4. Re-derivation: session is a member of a re-derivation pair (see
 *      `computeReDerivationRate`) -> "re-derived-later" (medium, negative).
 *   5. Citation: appears in evidence[] but is never the sole basis of a
 *      non-unobserved verdict (CITATION-DEGRADED rule). Citation-only stays
 *      "unobserved" with `producerDegraded: true`.
 *   No evidence at all -> "unobserved" (low).
 *
 * Supersession scope (v1, documented per the brief's escape hatch): only
 * session-level supersedence (`sessions.status` + `session_edges`) is
 * checked. The action-layer's revise/dismiss-decision overlay
 * (`@core/actions/overlay.js`) is read via raw better-sqlite3/pg handles,
 * not a port — wiring it here would mean either poking a DB handle into a
 * pure core module or inventing a new port purely to shave one edge case.
 * Session-level supersedence already covers the dominant case (an operator
 * or re-ingest retiring the whole session); revisiting per-decision overlay
 * correlation is left to a follow-up task if it proves to matter in practice.
 */

import type { OutcomeDeps, OutcomeVerdict } from "@ports/outcome.js";

const DEFAULT_HELD_AFTER_DAYS = 14;
const MS_PER_DAY = 86_400_000;

export async function deriveOutcome(sessionId: string, deps: OutcomeDeps): Promise<OutcomeVerdict> {
  const session = await deps.sessions.getById(sessionId);
  if (!session) {
    return { verdict: "unobserved", tier: "B", confidence: "low", evidence: [] };
  }

  // 1. Tier A: correlated signal rows are the strongest evidence and settle
  // the verdict outright, ahead of every heuristic below.
  const signals = await deps.signals.listForSession(sessionId);
  if (signals.length > 0) {
    const anyNegative = signals.some((s) => s.outcome !== "pass");
    return {
      verdict: anyNegative ? "overturned" : "held",
      tier: "A",
      confidence: "high",
      evidence: signals.map((s) => `signal:${s.id}`),
    };
  }

  const edges = await deps.edges.listForSession(sessionId);

  // 2. Supersession beats "held" beats continuation beats re-derivation.
  const supersedingEdge = edges.find(
    (e) => e.toSession === sessionId && (e.kind === "supersedes" || e.kind === "replaces"),
  );
  if (session.status === "superseded" || session.status === "replaced" || supersedingEdge) {
    return {
      verdict: "overturned",
      tier: "B",
      confidence: "high",
      evidence: [
        supersedingEdge
          ? `edge:${supersedingEdge.kind}:${supersedingEdge.fromSession}`
          : `session-status:${session.status}`,
      ],
    };
  }

  const heldAfterDays = deps.heldAfterDays ?? DEFAULT_HELD_AFTER_DAYS;
  if (session.endedAt !== null) {
    const now = (deps.now ?? (() => new Date()))();
    const elapsedDays = (now.getTime() - new Date(session.endedAt).getTime()) / MS_PER_DAY;
    if (elapsedDays >= heldAfterDays) {
      return {
        verdict: "held",
        tier: "B",
        confidence: "medium",
        evidence: [`held-after:${Math.floor(elapsedDays)}d`],
      };
    }
  }

  // 3. Continuation.
  const continuingEdge = edges.find((e) => e.toSession === sessionId && e.kind === "continues");
  if (continuingEdge) {
    return {
      verdict: "built-upon",
      tier: "B",
      confidence: "medium",
      evidence: [`edge:continues:${continuingEdge.fromSession}`],
    };
  }

  // 4. Re-derivation.
  const reDerivationPair = deps.reDerivationPairs.find((p) => p.a === sessionId || p.b === sessionId);
  if (reDerivationPair) {
    const other = reDerivationPair.a === sessionId ? reDerivationPair.b : reDerivationPair.a;
    return {
      verdict: "re-derived-later",
      tier: "B",
      confidence: "medium",
      evidence: [`re-derivation-pair:${other}`],
    };
  }

  // 5. Citation — evidence only, never a sole basis for a non-unobserved verdict.
  const citations = await deps.citations.listForSession(sessionId);
  if (citations.length > 0) {
    return {
      verdict: "unobserved",
      tier: "B",
      confidence: "low",
      evidence: citations.map((c) => `citation:${c.conversationId}`),
      producerDegraded: true,
    };
  }

  return { verdict: "unobserved", tier: "B", confidence: "low", evidence: [] };
}
