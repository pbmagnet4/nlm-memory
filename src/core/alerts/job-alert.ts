/**
 * Builds the `nlm.job.stalled` AlertEvent from a JobSupervisor event
 * (core/jobs/job-supervisor.ts). Pure — no fs/network, no debounce state
 * (unlike drift-transition.ts / embedder-transition.ts): JobSupervisor
 * already only emits one event per stalled/exhausted/spawn_failed episode,
 * so every event maps 1:1 to a fired alert. The daemon composition
 * root wires JobSupervisor's `onEvent` straight to
 * `fireAlert(buildJobAlertEvent(event))`.
 */

import type { JobSupervisorEvent } from "../jobs/job-supervisor.js";
import type { JobAlertEvent } from "./types.js";

export function buildJobAlertEvent(event: JobSupervisorEvent): JobAlertEvent {
  // `restarts` at "exhausted" is the number of respawns that actually
  // happened before the cap refused the next one — not restarts still
  // ahead. Spelling that out in prose here is the fix for a reviewer
  // misreading "restarts: 3" as "3 more restarts about to happen".
  const message =
    event.kind === "exhausted"
      ? `${event.job} gave up after ${event.restarts} fruitless restart${event.restarts === 1 ? "" : "s"} ` +
        `(${event.processed}/${event.total} processed)`
      : event.kind === "spawn_failed"
        ? `${event.job} failed to start — the child process itself would not spawn ` +
          `(${event.processed}/${event.total} processed, ${event.restarts} prior restarts)`
        : `${event.job} stalled — no progress since ${event.lastAdvanceAt ?? "start"} ` +
          `(${event.processed}/${event.total} processed)`;

  return {
    type: "nlm.job.stalled",
    data: {
      job: event.job,
      reason: event.kind,
      processed: event.processed,
      total: event.total,
      restarts: event.restarts,
      restartsTotal: event.restartsTotal,
      lastAdvanceAt: event.lastAdvanceAt,
      message,
    },
  };
}
