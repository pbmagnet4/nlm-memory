/**
 * One daemon tick of the fact-embedding sweep: repair what is due, re-measure
 * the missing share, publish it for /api/health, and alert on the rising edge
 * above the E1 threshold (and re-arm once it falls back under).
 */

import type { LLMClient } from "@ports/llm-client.js";
import type { AlertEvent } from "@core/alerts/types.js";
import { setFactEmbedSnapshot } from "@core/health/fact-embed-state.js";
import { MISSING_SHARE_ALARM, type FactEmbedStats } from "./embed-missing.js";
import { sweepFactEmbeddings, type FactSweepReport, type FactSweepStore } from "./embed-sweep.js";

export interface FactEmbedTickDeps {
  readonly tenantId: string;
  readonly store: FactSweepStore;
  /** Re-measures the missing share after the sweep (SQLite or Postgres). */
  readonly stats: () => FactEmbedStats | Promise<FactEmbedStats>;
  readonly embedder: LLMClient;
  readonly fire: (event: AlertEvent) => Promise<void>;
  readonly batchSize?: number;
  readonly now?: () => Date;
}

let alarmed = false;

export function resetFactEmbedTickForTests(): void {
  alarmed = false;
}

export async function runFactEmbedTick(deps: FactEmbedTickDeps): Promise<FactSweepReport> {
  const report = await sweepFactEmbeddings({
    tenantId: deps.tenantId,
    store: deps.store,
    embedder: deps.embedder,
    ...(deps.batchSize !== undefined ? { batchSize: deps.batchSize } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  });
  const stats = await deps.stats();
  const alarm = stats.missingShare > MISSING_SHARE_ALARM;
  setFactEmbedSnapshot({
    ...stats,
    thresholdShare: MISSING_SHARE_ALARM,
    alarm,
    computedAt: (deps.now ?? (() => new Date()))().toISOString(),
  });
  if (alarm && !alarmed) {
    await deps.fire({
      type: "nlm.facts.embedding_drop",
      data: {
        missing: stats.missing,
        active: stats.active,
        share: stats.missingShare,
        threshold: MISSING_SHARE_ALARM,
        pending: stats.pending,
        message:
          `${stats.missing} of ${stats.active} active facts have no embedding ` +
          `(${(stats.missingShare * 100).toFixed(2)}%, threshold ${MISSING_SHARE_ALARM * 100}%)`,
      },
    });
  }
  alarmed = alarm;
  return report;
}
