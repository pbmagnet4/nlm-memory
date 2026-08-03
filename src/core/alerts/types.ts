/**
 * Alert event shapes for NLM_ALERT_WEBHOOK daemon self-reporting.
 *
 * Field naming follows the CloudEvents 1.0 attribute set (specversion,
 * id, source, type, time, data) so a receiving webhook can decode the
 * envelope with an off-the-shelf CloudEvents SDK instead of a bespoke
 * NLM schema. `fireAlert` (see fire-alert.ts) builds the envelope; this
 * file only defines the event-specific `data` payload callers construct.
 */

export type AlertEventType =
  | "nlm.drift.version_behind"
  | "nlm.health.embedder_cold"
  | "nlm.job.stalled";

/**
 * Generic across both transition-based event types: `current` is the
 * observed value, `latest` is the target/expected value, `since` is the
 * ISO timestamp the current state began holding. For version drift that's
 * the installed vs. npm-latest version; for embedder health it's the
 * degraded ("cold") vs. healthy ("ready") state label.
 */
export interface AlertEventData {
  readonly current: string;
  readonly latest: string;
  readonly since: string;
}

/**
 * `nlm.job.stalled` payload — built by core/alerts/job-alert.ts from a
 * JobSupervisor event (core/jobs/job-supervisor.ts). Unlike the two
 * transition-based events above there's no debounce state: JobSupervisor
 * itself only emits "stalled"/"exhausted"/"spawn_failed" once per episode,
 * so every JobSupervisorEvent maps 1:1 to a fired alert.
 *
 * `restarts` is the restarts-without-progress counter AT the moment of
 * firing — for an "exhausted" event this is the number of respawns that
 * actually happened (it is always exactly the configured cap, e.g. 3), not
 * a count of restarts still to come, and not the cap plus the refused final
 * attempt. `message` spells this out in prose so a receiving Slack
 * relay/PagerDuty rule can't misread the number as restarts remaining.
 *
 * `restartsTotal` is the run's lifetime respawn count (never reset by
 * progress, unlike `restarts`) — see job-supervisor.ts's file-level doc.
 * It surfaces OOM-churn on a run that keeps making progress between
 * crashes, where `restarts` alone would read 0.
 *
 * `reason: "spawn_failed"` covers the case where `spawnChild` itself threw
 * synchronously (EMFILE/ENOMEM/bad binary) instead of the child ever
 * running — distinct from "exhausted" (ran, kept dying, used up its
 * restart budget) so an operator isn't left guessing why a job never
 * produced a single progress line.
 */
export interface JobAlertEventData {
  readonly job: "reprocess";
  readonly reason: "stalled" | "exhausted" | "spawn_failed";
  readonly processed: number;
  readonly total: number;
  readonly restarts: number;
  readonly restartsTotal: number;
  readonly lastAdvanceAt: string | null;
  readonly message: string;
}

export type AlertEvent =
  | { readonly type: "nlm.drift.version_behind"; readonly data: AlertEventData }
  | { readonly type: "nlm.health.embedder_cold"; readonly data: AlertEventData }
  | { readonly type: "nlm.job.stalled"; readonly data: JobAlertEventData };

/**
 * Per-producer narrowings of `AlertEvent`. Each transition/builder module
 * only ever constructs one union member, but declaring its return type as
 * the full `AlertEvent` erases the discriminant for callers (including
 * tests) that don't re-narrow via a type guard — `event.type` checked
 * through `expect()` doesn't narrow `event.data`. Producers should return
 * these instead; `fireAlert` still accepts any of them since each is a
 * subtype of `AlertEvent`.
 */
export type DriftAlertEvent = Extract<AlertEvent, { type: "nlm.drift.version_behind" }>;
export type EmbedderAlertEvent = Extract<AlertEvent, { type: "nlm.health.embedder_cold" }>;
export type JobAlertEvent = Extract<AlertEvent, { type: "nlm.job.stalled" }>;
