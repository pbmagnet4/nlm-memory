import { describe, it, expect } from "vitest";
import { checkHookInjection, type InjectionLogEntry } from "@core/digest/hook-injection.js";

const NOW = new Date("2026-05-30T08:00:00Z");
// Within the 48h window
const RECENT = "2026-05-29T15:00:00Z";
// Outside the 48h window
const OLD = "2026-05-27T10:00:00Z";

function liveEmptyEntry(ts: string): InjectionLogEntry {
  return { ts, mode: "live", gate: "evaluate", wouldInject: [], hits: [] };
}

function liveHitsNoInjectEntry(ts: string): InjectionLogEntry {
  return { ts, mode: "live", gate: "evaluate", wouldInject: [], hits: [{ id: "hm_abc123", score: 1.5 }] };
}

function liveFilledEntry(ts: string): InjectionLogEntry {
  return { ts, mode: "live", gate: "surface", wouldInject: ["hm_abc123"], hits: [{ id: "hm_abc123", score: 1.5 }] };
}

describe("checkHookInjection", () => {
  it("tier 1 alarms when 12 live fires all have empty wouldInject and hits", () => {
    const entries: InjectionLogEntry[] = Array.from({ length: 12 }, () => liveEmptyEntry(RECENT));
    const result = checkHookInjection(entries, NOW);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("WARN hook injecting nothing");
    expect(result.message).toContain("NLM_HOOK_RECALL_TIMEOUT_MS");
  });

  it("tier 2 alarms when fires carry hits but nothing passes selection", () => {
    const entries: InjectionLogEntry[] = Array.from({ length: 12 }, () => liveHitsNoInjectEntry(RECENT));
    const result = checkHookInjection(entries, NOW);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("WARN hook selection filtering all hits");
    expect(result.message).toContain("NLM_RECALL_SCORE_FLOOR");
  });

  it("a streak with one hits-bearing fire lands in tier 2, not tier 1", () => {
    const entries: InjectionLogEntry[] = [
      ...Array.from({ length: 11 }, () => liveEmptyEntry(RECENT)),
      liveHitsNoInjectEntry(RECENT),
    ];
    const result = checkHookInjection(entries, NOW);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("selection filtering");
    expect(result.message).not.toContain("injecting nothing");
  });

  it("does not alarm when at least one fire injects content", () => {
    const entries: InjectionLogEntry[] = [
      ...Array.from({ length: 11 }, () => liveEmptyEntry(RECENT)),
      liveFilledEntry(RECENT),
    ];
    const result = checkHookInjection(entries, NOW);
    expect(result.ok).toBe(true);
    expect(result.message).toBeNull();
  });

  it("does not alarm when fewer than 10 fires exist (quiet day)", () => {
    const entries: InjectionLogEntry[] = Array.from({ length: 5 }, () => liveEmptyEntry(RECENT));
    const result = checkHookInjection(entries, NOW);
    expect(result.ok).toBe(true);
    expect(result.message).toBeNull();
  });

  it("excludes gated-off fires (generative/skip) from the streak", () => {
    const entries: InjectionLogEntry[] = [
      ...Array.from({ length: 6 }, () => ({ ...liveEmptyEntry(RECENT), gate: "generative" })),
      ...Array.from({ length: 6 }, () => ({ ...liveEmptyEntry(RECENT), gate: "skip" })),
    ];
    const result = checkHookInjection(entries, NOW);
    expect(result.ok).toBe(true);
    expect(result.message).toBeNull();
  });

  it("excludes probe fires from both totals so probes never trigger the alarm", () => {
    const entries: InjectionLogEntry[] = Array.from({ length: 12 }, () => ({
      ...liveEmptyEntry(RECENT),
      query: "probe health check",
    }));
    const result = checkHookInjection(entries, NOW);
    expect(result.ok).toBe(true);
    expect(result.message).toBeNull();
  });

  it("excludes probe fires identified via promptPreview when no query field is present", () => {
    const entries: InjectionLogEntry[] = Array.from({ length: 12 }, () => ({
      ...liveEmptyEntry(RECENT),
      promptPreview: "recall test after restart",
    }));
    const result = checkHookInjection(entries, NOW);
    expect(result.ok).toBe(true);
    expect(result.message).toBeNull();
  });

  it("query-less fires are not excluded (they still count toward the streak)", () => {
    const entries: InjectionLogEntry[] = Array.from({ length: 12 }, () => liveEmptyEntry(RECENT));
    for (const e of entries) {
      expect(e.query).toBeUndefined();
      expect(e.prompt).toBeUndefined();
      expect(e.promptPreview).toBeUndefined();
    }
    const result = checkHookInjection(entries, NOW);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("WARN hook injecting nothing");
  });

  it("ignores shadow-mode entries", () => {
    const entries: InjectionLogEntry[] = Array.from({ length: 12 }, () => ({
      ts: RECENT,
      mode: "shadow",
      gate: "evaluate",
      wouldInject: [],
      hits: [],
    }));
    const result = checkHookInjection(entries, NOW);
    expect(result.ok).toBe(true);
    expect(result.message).toBeNull();
  });

  it("ignores entries outside the 48h window", () => {
    const entries: InjectionLogEntry[] = Array.from({ length: 12 }, () => liveEmptyEntry(OLD));
    const result = checkHookInjection(entries, NOW);
    expect(result.ok).toBe(true);
    expect(result.message).toBeNull();
  });
});
