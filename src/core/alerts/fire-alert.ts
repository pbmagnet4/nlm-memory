/**
 * fireAlert — POST a CloudEvents-shaped daemon self-report to an
 * operator-owned webhook.
 *
 * What this is: an opt-in outbound notification for drift/health
 * transitions (see drift-transition.ts, embedder-transition.ts) that the
 * operator wants pushed somewhere (Slack relay, PagerDuty, a log sink)
 * instead of only surfacing on the next `nlm start` banner or
 * `GET /api/health` poll.
 *
 * What this is not: telemetry back to an NLM-owned server. Nothing
 * fires unless the operator sets NLM_ALERT_WEBHOOK themselves, and the
 * payload never leaves the process until then.
 *
 * Contract: skip silently (zero network calls) when NLM_ALERT_WEBHOOK is
 * unset. Otherwise POST with a 5s timeout, one retry on failure, and
 * never throw — a webhook outage must never take the daemon down.
 */

import { randomUUID } from "node:crypto";
import type { AlertEvent } from "./types.js";

const TIMEOUT_MS = 5_000;
const SOURCE = "nlm-memory";

export interface FireAlertDeps {
  readonly now?: () => Date;
  readonly fetchImpl?: typeof fetch;
}

export async function fireAlert(
  event: AlertEvent,
  deps: FireAlertDeps = {},
): Promise<void> {
  const url = process.env["NLM_ALERT_WEBHOOK"];
  if (!url) return;

  const now = deps.now ?? (() => new Date());
  const fetchImpl = deps.fetchImpl ?? fetch;
  const envelope = {
    specversion: "1.0",
    id: randomUUID(),
    source: SOURCE,
    type: event.type,
    time: now().toISOString(),
    datacontenttype: "application/json",
    data: event.data,
  };

  const ok = await attemptPost(url, envelope, fetchImpl);
  if (!ok) {
    // Single retry on the first failure (network error, timeout, or
    // non-2xx) — best-effort delivery, no third attempt.
    await attemptPost(url, envelope, fetchImpl);
  }
}

async function attemptPost(
  url: string,
  envelope: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const token = process.env["NLM_ALERT_WEBHOOK_TOKEN"];
    const headers: Record<string, string> = {
      "content-type": "application/cloudevents+json",
    };
    if (token) headers["authorization"] = `Bearer ${token}`;
    const r = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(envelope),
      signal: controller.signal,
    });
    return r.ok;
  } catch {
    // Network failure, abort-on-timeout, or a thrown Response error —
    // alert delivery is best-effort, so the caller decides whether to
    // retry rather than propagating this up.
    return false;
  } finally {
    clearTimeout(timer);
  }
}
