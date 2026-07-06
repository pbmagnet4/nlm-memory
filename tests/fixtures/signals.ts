import type { Signal } from "../../src/shared/types.js";

export function makeSignal(overrides: Partial<Signal> = {}): Signal {
  const base: Signal = {
    id: "sig_test_1",
    v: 1,
    installScope: "install-test",
    kind: "gate",
    producer: "quality-gate",
    outcome: "fail",
    model: "qwen3-coder",
    repo: "/repo/x",
    step: "types",
    detail: { files: ["a.ts"], attempt: 1 },
    sessionId: "pi_test_1",
    scope: null,
    ts: "2026-06-09T18:00:00.000Z",
    createdAt: "2026-06-09T18:00:01.000Z",
  };
  return { ...base, ...overrides };
}
