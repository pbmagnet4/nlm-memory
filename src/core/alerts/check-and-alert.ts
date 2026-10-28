/**
 * Daemon-facing entry points: read persisted alert state, evaluate the
 * relevant transition, fire the webhook if the transition says so, and
 * persist the updated state. This is the only module the CLI wiring
 * (src/cli/nlm.ts) needs to import — it doesn't touch transition logic
 * or the webhook POST directly.
 */

import { getUpdateStatus, type UpdateCheckDeps } from "../update-check/check.js";
import { warmupSnapshot } from "../health/warmup-state.js";
import { readAlertState, writeAlertState, defaultAlertStatePath } from "./alert-state.js";
import { evaluateDriftTransition } from "./drift-transition.js";
import { evaluateEmbedderTransition } from "./embedder-transition.js";
import { evaluateIngestLagTransition } from "./ingest-lag-transition.js";
import type { IngestLagReport } from "../health/ingest-lag.js";
import { fireAlert } from "./fire-alert.js";

export interface CheckDriftDeps {
  readonly currentVersion: string;
  readonly now?: () => Date;
  readonly fetchImpl?: typeof fetch;
  readonly statePath?: string;
  readonly updateCheckDeps?: Partial<UpdateCheckDeps>;
}

/** Refresh path: calls the real (cache-respecting) update check, then
 *  evaluates + fires the version-drift transition. Safe to call on a
 *  tight interval — getUpdateStatus's own 24h TTL means this is a cache
 *  read except once a day. */
export async function checkDriftAndAlert(deps: CheckDriftDeps): Promise<void> {
  const now = deps.now ?? (() => new Date());
  const statePath = deps.statePath ?? defaultAlertStatePath();
  const state = await readAlertState(statePath);

  const status = await getUpdateStatus({
    currentVersion: deps.currentVersion,
    now,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    ...deps.updateCheckDeps,
  });

  const result = evaluateDriftTransition(state.drift, status, now());
  if (result.fire && result.event) {
    await fireAlert(result.event, {
      now,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    });
  }
  await writeAlertState(statePath, { ...state, drift: result.next });
}

export interface CheckEmbedderDeps {
  readonly now?: () => Date;
  readonly fetchImpl?: typeof fetch;
  readonly statePath?: string;
}

/** Polls the in-process warmup flag (see health/warmup-state.ts) and
 *  evaluates + fires the embedder-cold transition. */
export async function checkEmbedderAndAlert(deps: CheckEmbedderDeps = {}): Promise<void> {
  const now = deps.now ?? (() => new Date());
  const statePath = deps.statePath ?? defaultAlertStatePath();
  const state = await readAlertState(statePath);

  const ready = warmupSnapshot().ready;
  const result = evaluateEmbedderTransition(state.embedderCold, ready, now());
  if (result.fire && result.event) {
    await fireAlert(result.event, {
      now,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    });
  }
  await writeAlertState(statePath, { ...state, embedderCold: result.next });
}

/** Evaluates + fires the ingest-lag enter/recover transition from the monitor's report. */
export async function checkIngestLagAndAlert(
  getReport: () => Promise<IngestLagReport>,
  deps: CheckEmbedderDeps = {},
): Promise<void> {
  const now = deps.now ?? (() => new Date());
  const statePath = deps.statePath ?? defaultAlertStatePath();
  const state = await readAlertState(statePath);

  const report = await getReport();
  const result = evaluateIngestLagTransition(state.ingestLag, report.lagging, report.summary, now());
  if (result.event) {
    await fireAlert(result.event, {
      now,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    });
  }
  await writeAlertState(statePath, { ...state, ingestLag: result.next });
}
