import type { Session } from "../../src/shared/types.js";

export function makeSession(overrides: Partial<Session> = {}): Session {
  const base: Session = {
    id: "cc_test_1",
    runtime: "claude-code",
    runtimeSessionId: "test-1",
    startedAt: "2026-05-19T10:00:00Z",
    endedAt: "2026-05-19T10:30:00Z",
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
