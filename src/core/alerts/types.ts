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
  | "nlm.health.embedder_cold";

/**
 * Generic across both event types: `current` is the observed value,
 * `latest` is the target/expected value, `since` is the ISO timestamp
 * the current state began holding. For version drift that's the
 * installed vs. npm-latest version; for embedder health it's the
 * degraded ("cold") vs. healthy ("ready") state label.
 */
export interface AlertEventData {
  readonly current: string;
  readonly latest: string;
  readonly since: string;
}

export interface AlertEvent {
  readonly type: AlertEventType;
  readonly data: AlertEventData;
}
