import { describe, expect, it } from "vitest";
import type { Signal, SignalInput, SignalKind, SignalOutcome } from "../../../../src/shared/types.js";

describe("signal types", () => {
  it("constructs a Signal with all fields", () => {
    const s: Signal = {
      id: "sig_1",
      v: 1,
      installScope: "install-abc",
      kind: "gate",
      producer: "quality-gate",
      outcome: "fail",
      model: "qwen3-coder",
      repo: "/repo/x",
      step: "types",
      detail: { files: ["a.ts"], attempt: 2 },
      sessionId: "pi_123",
      scope: null,
      ts: "2026-06-09T18:00:00.000Z",
      createdAt: "2026-06-09T18:00:01.000Z",
    };
    expect(s.kind).toBe("gate");
  });

  it("constructs a SignalInput (producer-side, no install/id)", () => {
    const i: SignalInput = {
      kind: "gate",
      producer: "quality-gate",
      outcome: "pass",
      model: "qwen3-coder",
      repo: "/repo/x",
      step: null,
      detail: null,
      session: null,
      ts: "2026-06-09T18:00:00.000Z",
    };
    const k: SignalKind = i.kind;
    const o: SignalOutcome = i.outcome;
    expect([k, o]).toEqual(["gate", "pass"]);
  });
});
