import { describe, expect, it } from "vitest";
import { normalizeSignal, signalId } from "../../../../src/core/signals/ingest-signal.js";

const NOW = () => "2026-06-09T12:00:00.000Z";

describe("normalizeSignal", () => {
  it("normalizes a full payload and derives step from detail", () => {
    const s = normalizeSignal(
      {
        v: 1, kind: "gate", producer: "quality-gate", outcome: "fail",
        model: "qwen3-coder", repo: "/repo/x",
        detail: { step: "types", files: ["a.ts"], attempt: 2 },
        session: "pi_9", ts: "2026-06-09T18:00:00.000Z",
      },
      "install-1", NOW,
    );
    expect(s.step).toBe("types");
    expect(s.installScope).toBe("install-1");
    expect(s.sessionId).toBe("pi_9");
    expect(s.createdAt).toBe("2026-06-09T12:00:00.000Z");
  });

  it("is deterministic: same (session, producer, ts, step, outcome) -> same id", () => {
    const base = { kind: "gate", producer: "qg", outcome: "fail", model: "m", repo: "/r", detail: { step: "lint" }, session: "s1", ts: "2026-06-09T18:00:00.000Z" };
    expect(normalizeSignal(base, "i", NOW).id).toBe(normalizeSignal(base, "i", NOW).id);
  });

  it("soft-defaults missing model/repo/producer to 'unknown' and ts to now()", () => {
    const s = normalizeSignal({ kind: "test", outcome: "pass", step: null, detail: null, session: null }, "i", NOW);
    expect([s.model, s.repo, s.producer, s.ts]).toEqual(["unknown", "unknown", "unknown", "2026-06-09T12:00:00.000Z"]);
  });

  it("throws on invalid kind (lane definer)", () => {
    expect(() => normalizeSignal({ kind: "bogus", outcome: "pass" }, "i", NOW)).toThrow(/kind/);
  });

  it("throws on invalid outcome (lane definer)", () => {
    expect(() => normalizeSignal({ kind: "gate", outcome: "boom" }, "i", NOW)).toThrow(/outcome/);
  });

  it("throws on non-object payload", () => {
    expect(() => normalizeSignal("nope", "i", NOW)).toThrow();
  });

  it("signalId is stable", () => {
    const a = signalId({ sessionId: "s", producer: "p", ts: "t", step: "x", outcome: "fail" });
    const b = signalId({ sessionId: "s", producer: "p", ts: "t", step: "x", outcome: "fail" });
    expect(a).toBe(b);
    expect(a).toMatch(/^sig_[0-9a-f]{16}$/);
  });
});
