/**
 * Corpus-level Tier-B outcome coverage (#352 phase 2, Task 8).
 *
 * The digest's coverage block needs verdict counts across every session
 * ended in a window (hundreds of sessions), not one session at a time.
 * Calling `deriveOutcome` in a loop with per-session reader ports would mean
 * one round trip per evidence type *per session*. Instead, the caller
 * batches each evidence type into one query across the whole id set
 * (`OutcomeCoverageInput`'s maps), and this module wraps those maps into the
 * same narrow per-session reader shape `deriveOutcome` already expects — so
 * the precedence logic itself is never duplicated, only its I/O is batched.
 */

import { deriveOutcome } from "./rollup.js";
import type {
  OutcomeCitation,
  OutcomeEdge,
  OutcomeSession,
  OutcomeSignal,
} from "@ports/outcome.js";
import type { ReDerivationPair } from "@core/metrics/re-derivation.js";

export interface OutcomeCoverageInput {
  readonly sessions: ReadonlyArray<OutcomeSession>;
  readonly signalsBySession: ReadonlyMap<string, ReadonlyArray<OutcomeSignal>>;
  readonly edgesBySession: ReadonlyMap<string, ReadonlyArray<OutcomeEdge>>;
  readonly citationsBySession: ReadonlyMap<string, ReadonlyArray<OutcomeCitation>>;
  readonly reDerivationPairs: ReadonlyArray<ReDerivationPair>;
  /** Injected clock, forwarded to `deriveOutcome`. Defaults to `Date.now()`. */
  readonly now?: () => Date;
  readonly heldAfterDays?: number;
}

export interface OutcomeCoverage {
  readonly total: number;
  readonly held: number;
  readonly overturned: number;
  readonly builtUpon: number;
  readonly reDerivedLater: number;
  readonly unobserved: number;
}

export async function computeOutcomeCoverage(tenantId: string, input: OutcomeCoverageInput): Promise<OutcomeCoverage> {
  const counts = { held: 0, overturned: 0, builtUpon: 0, reDerivedLater: 0, unobserved: 0 };

  for (const session of input.sessions) {
    const verdict = await deriveOutcome(tenantId, session.id, {
      sessions: { getById: async () => session },
      signals: { listForSession: async () => input.signalsBySession.get(session.id) ?? [] },
      edges: { listForSession: async () => input.edgesBySession.get(session.id) ?? [] },
      citations: { listForSession: async () => input.citationsBySession.get(session.id) ?? [] },
      reDerivationPairs: input.reDerivationPairs,
      ...(input.now ? { now: input.now } : {}),
      ...(input.heldAfterDays !== undefined ? { heldAfterDays: input.heldAfterDays } : {}),
    });

    switch (verdict.verdict) {
      case "held":
        counts.held++;
        break;
      case "overturned":
        counts.overturned++;
        break;
      case "built-upon":
        counts.builtUpon++;
        break;
      case "re-derived-later":
        counts.reDerivedLater++;
        break;
      case "unobserved":
        counts.unobserved++;
        break;
    }
  }

  return { total: input.sessions.length, ...counts };
}
