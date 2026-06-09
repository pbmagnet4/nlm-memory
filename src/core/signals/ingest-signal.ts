/**
 * Boundary validation + normalization for inbound signals (HTTP and
 * session-embedded share this). kind/outcome are the lane definers - invalid
 * values throw (fail loud at the boundary). producer/model/repo/ts soft-default
 * so a sloppy-but-valid producer still records data rather than being dropped.
 *
 * The id is deterministic over (session, producer, ts, step, outcome) so a
 * session file re-parsed after it grows re-emits the same ids and the store's
 * ON CONFLICT DO NOTHING makes re-ingest a no-op.
 */

import { createHash } from "node:crypto";
import type { Signal, SignalKind, SignalOutcome } from "@shared/types.js";

const KINDS: ReadonlySet<string> = new Set(["gate", "eval", "review", "test"]);
const OUTCOMES: ReadonlySet<string> = new Set(["pass", "fail", "fix", "exhausted"]);

export function signalId(parts: {
  sessionId: string | null;
  producer: string;
  ts: string;
  step: string | null;
  outcome: string;
}): string {
  const hash = createHash("sha256")
    .update([parts.sessionId ?? "", parts.producer, parts.ts, parts.step ?? "", parts.outcome].join("|"))
    .digest("hex")
    .slice(0, 16);
  return `sig_${hash}`;
}

export function normalizeSignal(
  raw: unknown,
  installScope: string,
  now: () => string = () => new Date().toISOString(),
): Signal {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("signal payload must be a JSON object");
  }
  const o = raw as Record<string, unknown>;

  const kind = o["kind"];
  if (typeof kind !== "string" || !KINDS.has(kind)) {
    throw new Error(`signal.kind must be one of gate|eval|review|test (got ${String(kind)})`);
  }
  const outcome = o["outcome"];
  if (typeof outcome !== "string" || !OUTCOMES.has(outcome)) {
    throw new Error(`signal.outcome must be one of pass|fail|fix|exhausted (got ${String(outcome)})`);
  }

  const str = (key: string, fallback: string): string =>
    typeof o[key] === "string" && (o[key] as string).length > 0 ? (o[key] as string) : fallback;

  const detail =
    o["detail"] && typeof o["detail"] === "object" && !Array.isArray(o["detail"])
      ? (o["detail"] as Record<string, unknown>)
      : null;
  const step =
    detail && typeof detail["step"] === "string"
      ? (detail["step"] as string)
      : typeof o["step"] === "string"
        ? (o["step"] as string)
        : null;
  const sessionId = typeof o["session"] === "string" && (o["session"] as string).length > 0 ? (o["session"] as string) : null;
  const ts = typeof o["ts"] === "string" && (o["ts"] as string).length > 0 ? (o["ts"] as string) : now();
  const v = typeof o["v"] === "number" ? o["v"] : 1;
  const producer = str("producer", "unknown");

  return {
    id: signalId({ sessionId, producer, ts, step, outcome }),
    v,
    installScope,
    kind: kind as SignalKind,
    producer,
    outcome: outcome as SignalOutcome,
    model: str("model", "unknown"),
    repo: str("repo", "unknown"),
    step,
    detail,
    sessionId,
    ts,
    createdAt: now(),
  };
}
