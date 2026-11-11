import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DEFAULT_DREAM_MODEL } from "@core/dream/judge.js";
import {
  CONTRADICTION_APPLY_GATE,
  DEFAULT_CONTRADICTION_SAMPLE_SIZE,
  DEFAULT_DEDUP_SAMPLE_SIZE,
  DEFAULT_MAX_IN_FLIGHT,
  DEFAULT_PASS_CADENCE_MS,
  DreamSettingsError,
  dreamSettingsFromEnv,
  getDreamSettings,
  lastRuns,
  recordLastRun,
  reseedDreamSettings,
  resetLastRuns,
  updateDreamSettings,
} from "@core/dream/settings.js";

/** The settings module is mutable module state; every test starts from a
 *  clean blank env so process.env can never leak into expectations. */
beforeEach(() => {
  reseedDreamSettings({});
  resetLastRuns();
});

describe("dream settings — defaults", () => {
  it("blank env yields the documented defaults", () => {
    const s = dreamSettingsFromEnv({});
    expect(s.model).toBe(DEFAULT_DREAM_MODEL);
    expect(s.contradiction).toEqual({
      enabled: false,
      cadenceMs: DEFAULT_PASS_CADENCE_MS,
      sampleSize: DEFAULT_CONTRADICTION_SAMPLE_SIZE,
      maxInFlight: DEFAULT_MAX_IN_FLIGHT,
      applyMode: "dry-run",
    });
    expect(s.dedup).toEqual({
      enabled: false,
      cadenceMs: DEFAULT_PASS_CADENCE_MS,
      sampleSize: DEFAULT_DEDUP_SAMPLE_SIZE,
      applyMode: "dry-run",
    });
  });

  it("default cadence is once a day", () => {
    expect(DEFAULT_PASS_CADENCE_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("getDreamSettings returns a snapshot; mutating it changes nothing", () => {
    const snap = getDreamSettings();
    snap.model = "hacked";
    snap.contradiction.sampleSize = 999;
    expect(getDreamSettings().model).toBe(DEFAULT_DREAM_MODEL);
    expect(getDreamSettings().contradiction.sampleSize).toBe(DEFAULT_CONTRADICTION_SAMPLE_SIZE);
  });
});

describe("dream settings — env seeding", () => {
  it("NLM_DREAM_MODEL overrides the model; blank falls back", () => {
    expect(dreamSettingsFromEnv({ NLM_DREAM_MODEL: "qwen-mini" }).model).toBe("qwen-mini");
    expect(dreamSettingsFromEnv({ NLM_DREAM_MODEL: "   " }).model).toBe(DEFAULT_DREAM_MODEL);
  });

  it("passes seed enabled only on 1/true", () => {
    const on = dreamSettingsFromEnv({ NLM_DREAM_CONTRADICTION_PASS: "1", NLM_DREAM_DEDUP_PASS: "true" });
    expect(on.contradiction.enabled).toBe(true);
    expect(on.dedup.enabled).toBe(true);
    const off = dreamSettingsFromEnv({ NLM_DREAM_CONTRADICTION_PASS: "yes", NLM_DREAM_DEDUP_PASS: "0" });
    expect(off.contradiction.enabled).toBe(false);
    expect(off.dedup.enabled).toBe(false);
  });

  it("apply env flips applyMode; anything else stays dry-run", () => {
    const applied = dreamSettingsFromEnv({ NLM_DREAM_CONTRADICTION_APPLY: "true", NLM_DREAM_DEDUP_APPLY: "1" });
    expect(applied.contradiction.applyMode).toBe("apply");
    expect(applied.dedup.applyMode).toBe("apply");
    expect(dreamSettingsFromEnv({ NLM_DREAM_CONTRADICTION_APPLY: "false" }).contradiction.applyMode).toBe("dry-run");
  });

  it("sample, in-flight and cadence seeds; invalid values fall back to defaults", () => {
    const seeded = dreamSettingsFromEnv({
      NLM_DREAM_CONTRADICTION_SAMPLE: "50",
      NLM_DREAM_CONTRADICTION_MAX_INFLIGHT: "2",
      NLM_DREAM_CONTRADICTION_CADENCE_MS: "3600000",
      NLM_DREAM_DEDUP_SAMPLE: "500",
      NLM_DREAM_DEDUP_CADENCE_MS: "600000",
    });
    expect(seeded.contradiction.sampleSize).toBe(50);
    expect(seeded.contradiction.maxInFlight).toBe(2);
    expect(seeded.contradiction.cadenceMs).toBe(3_600_000);
    expect(seeded.dedup.sampleSize).toBe(500);
    expect(seeded.dedup.cadenceMs).toBe(600_000);

    const bad = dreamSettingsFromEnv({
      NLM_DREAM_CONTRADICTION_SAMPLE: "abc",
      NLM_DREAM_CONTRADICTION_MAX_INFLIGHT: "-3",
      NLM_DREAM_DEDUP_CADENCE_MS: "0",
    });
    expect(bad.contradiction.sampleSize).toBe(DEFAULT_CONTRADICTION_SAMPLE_SIZE);
    expect(bad.contradiction.maxInFlight).toBe(DEFAULT_MAX_IN_FLIGHT);
    expect(bad.dedup.cadenceMs).toBe(DEFAULT_PASS_CADENCE_MS);
  });

  it("reseed replaces current values wholesale from the env source", () => {
    updateDreamSettings({ model: "temp-model", dedup: { enabled: true } });
    const reseeded = reseedDreamSettings({ NLM_DREAM_MODEL: "from-env", NLM_DREAM_DEDUP_PASS: "1" });
    expect(reseeded.model).toBe("from-env");
    expect(reseeded.dedup.enabled).toBe(true);
    expect(getDreamSettings()).toEqual(reseeded);
  });
});

describe("dream settings — update validation", () => {
  it("merges partial patches and returns the new snapshot", () => {
    const next = updateDreamSettings({ model: "new-model", dedup: { applyMode: "apply" } });
    expect(next.model).toBe("new-model");
    expect(next.dedup.applyMode).toBe("apply");
    expect(next.dedup.sampleSize).toBe(DEFAULT_DEDUP_SAMPLE_SIZE);
    expect(next.contradiction).toEqual(getDreamSettings().contradiction);
  });

  it("trims the model value", () => {
    expect(updateDreamSettings({ model: "  trimmed  " }).model).toBe("trimmed");
  });

  it("rejects an unknown pass or setting", () => {
    expect(() => updateDreamSettings({ contradiction: {} , reflexion: { enabled: true } })).toThrow(DreamSettingsError);
    expect(() => updateDreamSettings({ dreamloop: {} })).toThrow(/unknown pass or setting/);
  });

  it("rejects an unknown field on a pass", () => {
    expect(() => updateDreamSettings({ dedup: { interval: 5 } })).toThrow(/unknown field "interval" on pass "dedup"/);
  });

  it("rejects maxInFlight on dedup: the dedup lane runs no judge pool", () => {
    const before = getDreamSettings();
    expect(() => updateDreamSettings({ dedup: { maxInFlight: 8 } })).toThrow(/unknown field "maxInFlight" on pass "dedup"/);
    expect(getDreamSettings()).toEqual(before);
    expect(dreamSettingsFromEnv({ NLM_DREAM_DEDUP_MAX_INFLIGHT: "8" }).dedup).not.toHaveProperty("maxInFlight");
  });

  it("rejects bad shapes on every field", () => {
    expect(() => updateDreamSettings({ model: "" })).toThrow(DreamSettingsError);
    expect(() => updateDreamSettings({ model: 42 })).toThrow(DreamSettingsError);
    expect(() => updateDreamSettings("nope")).toThrow(DreamSettingsError);
    expect(() => updateDreamSettings({ dedup: "on" })).toThrow(DreamSettingsError);
    expect(() => updateDreamSettings({ dedup: { enabled: "yes" } })).toThrow(/must be a boolean/);
    expect(() => updateDreamSettings({ contradiction: { cadenceMs: 1.5 } })).toThrow(/positive integer/);
    expect(() => updateDreamSettings({ contradiction: { sampleSize: 0 } })).toThrow(/positive integer/);
    expect(() => updateDreamSettings({ contradiction: { maxInFlight: "4" } })).toThrow(/positive integer/);
    expect(() => updateDreamSettings({ dedup: { applyMode: "on" } })).toThrow(/dry-run.*apply/);
  });

  it("an invalid patch is all-or-nothing: current values stay untouched", () => {
    const before = getDreamSettings();
    expect(() => updateDreamSettings({ model: "ok-but", dedup: { sampleSize: -1 } })).toThrow(DreamSettingsError);
    expect(getDreamSettings()).toEqual(before);
  });
});

describe("dream settings — contradiction apply gate (T1641)", () => {
  /** A gate that has passed, for the one case the live gate cannot express:
   *  the refusal is the gate's state, not a hard-coded ban. */
  const PASSED = { passed: true, evidence: "T1609 relabel precision 12/12 (2026-11-10)" };

  it("records the live gate as not passed, with its evidence", () => {
    expect(CONTRADICTION_APPLY_GATE.passed).toBe(false);
    expect(CONTRADICTION_APPLY_GATE.evidence).toMatch(/precision/);
  });

  it("refuses contradiction applyMode \"apply\" while the gate has not passed", () => {
    expect(() => updateDreamSettings({ contradiction: { applyMode: "apply" } })).toThrow(DreamSettingsError);
    let message = "";
    try {
      updateDreamSettings({ contradiction: { applyMode: "apply" } });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/precision gate/);
    expect(message).toContain(CONTRADICTION_APPLY_GATE.evidence);
    expect(getDreamSettings().contradiction.applyMode).toBe("dry-run");
  });

  it("refuses it as all-or-nothing: nothing else in the patch sticks", () => {
    const before = getDreamSettings();
    expect(() =>
      updateDreamSettings({
        model: "should-not-stick",
        dedup: { enabled: true },
        contradiction: { enabled: true, sampleSize: 5, applyMode: "apply" },
      }),
    ).toThrow(DreamSettingsError);
    expect(getDreamSettings()).toEqual(before);
  });

  it("accepts \"dry-run\" and an untouched applyMode", () => {
    expect(updateDreamSettings({ contradiction: { applyMode: "dry-run" } }).contradiction.applyMode).toBe("dry-run");
    expect(updateDreamSettings({ contradiction: { enabled: true } }).contradiction.applyMode).toBe("dry-run");
  });

  it("leaves dedup apply ungated: this gate is the contradiction pass's precision only", () => {
    expect(updateDreamSettings({ dedup: { applyMode: "apply" } }).dedup.applyMode).toBe("apply");
  });

  it("accepts contradiction apply once the gate has passed (injected gate)", () => {
    expect(updateDreamSettings({ contradiction: { applyMode: "apply" } }, PASSED).contradiction.applyMode).toBe("apply");
  });

  it("env seeding stays the operator's own switch: reseed is not gated", () => {
    const seeded = reseedDreamSettings({ NLM_DREAM_CONTRADICTION_APPLY: "1" });
    expect(seeded.contradiction.applyMode).toBe("apply");
    // A patch that does not touch applyMode must not trip the gate either.
    expect(updateDreamSettings({ contradiction: { enabled: true } }).contradiction.applyMode).toBe("apply");
  });
});

describe("dream settings — last-run registry", () => {
  it("empty until a pass records, one record per pass, latest wins", () => {
    expect(lastRuns()).toEqual({ contradiction: null, dedup: null });

    recordLastRun("contradiction", { sampled: 20, superseded: 1 });
    recordLastRun("dedup", { proposals: 3 });
    const first = lastRuns().contradiction!;
    expect(first.name).toBe("contradiction");
    expect(first.summary).toEqual({ sampled: 20, superseded: 1 });
    expect(Date.parse(first.ranAt)).not.toBeNaN();

    recordLastRun("contradiction", { sampled: 5, superseded: 0 });
    const runs = lastRuns();
    expect(runs.contradiction!.summary).toEqual({ sampled: 5, superseded: 0 });
    expect(runs.dedup!.summary).toEqual({ proposals: 3 });
  });

  it("records the wall-clock time of the run", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-09T03:00:00.000Z"));
    try {
      expect(recordLastRun("dedup", {}).ranAt).toBe("2026-11-09T03:00:00.000Z");
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects unknown pass names and non-object summaries", () => {
    expect(() => recordLastRun("reflexion", {})).toThrow(/unknown pass/);
    expect(() => recordLastRun("dedup", null as unknown as Record<string, unknown>)).toThrow(/must be an object/);
    expect(() => recordLastRun("dedup", [] as unknown as Record<string, unknown>)).toThrow(DreamSettingsError);
    expect(lastRuns()).toEqual({ contradiction: null, dedup: null });
  });

  it("reset clears the registry", () => {
    recordLastRun("dedup", { ok: true });
    resetLastRuns();
    expect(lastRuns()).toEqual({ contradiction: null, dedup: null });
  });

  it("hands out copies: mutating a returned record cannot corrupt the registry", () => {
    const returned = recordLastRun("contradiction", { sampled: 7 });
    (returned.summary as Record<string, unknown>).sampled = 999;
    (lastRuns().contradiction!.summary as Record<string, unknown>).sampled = 888;
    expect(lastRuns().contradiction!.summary).toEqual({ sampled: 7 });
  });
});

afterEach(() => vi.useRealTimers());
