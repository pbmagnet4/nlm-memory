import type { Session } from "../../src/shared/types.js";

export function makeSession(overrides: Partial<Session> = {}): Session {
  // Default startedAt to "now" so the RecallService recency multiplier
  // returns ~1.0 in unit tests that aren't specifically about age-decay.
  // Override explicitly to test recency-driven re-ranking.
  const now = new Date().toISOString();
  const base: Session = {
    id: "cc_test_1",
    runtime: "claude-code",
    runtimeSessionId: "test-1",
    startedAt: now,
    endedAt: now,
    durationMin: 30,
    label: "Untitled session",
    summary: "",
    status: "closed",
    transcriptKind: "claude-code-jsonl",
    transcriptPath: null,
    body: "",
    entities: [],
    decisions: [],
    open: [],
  };
  return { ...base, ...overrides };
}
