/**
 * Builds the `nlm.job.stalled` AlertEvent from a JobSupervisor event
 * (core/jobs/job-supervisor.ts). Pure — no fs/network, no debounce state
 * (unlike drift-transition.ts / embedder-transition.ts): JobSupervisor
 * already only emits "stalled" once per stall episode and "exhausted" once
 * per run, so every event maps 1:1 to a fired alert. The daemon composition
 * root wires JobSupervisor's `onEvent` straight to
 * `fireAlert(buildJobAlertEvent(event))`.
 */

import type { JobSupervisorEvent } from "../jobs/job-supervisor.js";
import type { AlertEvent } from "./types.js";

export function buildJobAlertEvent(event: JobSupervisorEvent): AlertEvent {
  // `restarts` at "exhausted" is the counter value that tripped the cap —
  // it already counts the refused final attempt, not restarts still ahead.
  // Spelling that out in prose here is the fix for a reviewer misreading
  // "restarts: 3" as "3 more restarts about to happen".
  const message =
    event.kind === "exhausted"
      ? `${event.job} gave up after ${event.restarts} fruitless restart${event.restarts === 1 ? "" : "s"} ` +
        `(${event.processed}/${event.total} processed)`
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
      lastAdvanceAt: event.lastAdvanceAt,
      message,
    },
  };
}
