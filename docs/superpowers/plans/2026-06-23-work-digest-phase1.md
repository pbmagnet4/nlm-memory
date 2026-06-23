# Work Digest — Phase 1 (NLM core + agent pull) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the generic NLM-core daily work-digest — active-time-by-topic, focus quality, and progress — computed from transcript message-timestamp gaps, exposed through a `work_summary` MCP tool and an `nlm work-digest` CLI.

**Architecture:** A pure `WorkDigest` core (small, independently-testable stages: active-spans → merge → attribute → compose) plus one I/O loader that reads sessions and transcripts. Two thin adapters (MCP tool, CLI) render the same `WorkDigest`. No NLOS concepts; the topic taxonomy is a pluggable provider and `byTopic[].meta` is an empty pass-through seam.

**Tech Stack:** TypeScript (strict, ESM, `.js` import specifiers), better-sqlite3 store, commander CLI, `@modelcontextprotocol/sdk` MCP, vitest.

## Global Constraints

- **TDD always.** Failing test first → watch it fail for the right reason → minimal code → green. `npm run test` and `npm run typecheck` both clean before each commit. (Known pre-existing failure: `tests/integration/citation-explicit.test.ts` "drops an unattributable citation" — task #365, unrelated; ignore it.)
- **NLM core stays generic.** No "function", "autonomy tier", "client", or NLOS concept in any file this plan touches. Taxonomy is the topic provider; extension data rides only in the opaque `byTopic[].meta`.
- **No em dashes in operator-facing copy** (the composed digest text). Plain separators only. Spec/plan prose may use them; the rendered digest may not.
- **Message timestamps are UTC ISO** (e.g. `2026-06-23T19:37:33.041Z`); day boundaries are computed in the daemon's local timezone (America/Chicago).
- **Defaults:** idle threshold 5 min (`NLM_WORK_IDLE_THRESHOLD_MIN`), deep-work block 25 min (`NLM_WORK_DEEP_BLOCK_MIN`).
- **Module layout:** pure stages in `src/core/work-digest/`; tests in `tests/unit/core/work-digest/` and `tests/integration/`. Pure modules import nothing with I/O; only `build-work-digest.ts` touches the filesystem/store.
- **Commits:** one per task, conventional-commit style, end with the repo's Co-Authored-By + Claude-Session trailers.

---

### Task 1: WorkDigest types + `activeSpans`

**Files:**
- Create: `src/core/work-digest/types.ts`
- Create: `src/core/work-digest/active-spans.ts`
- Test: `tests/unit/core/work-digest/active-spans.test.ts`

**Interfaces:**
- Produces: `Interval { start: number; end: number }` (epoch ms); the `WorkDigest`/`SessionActivity`/`TopicShare`/`FocusStats`/`ProgressStats`/`Coverage` types; `activeSpans(timestampsMs: ReadonlyArray<number>, idleThresholdMin: number): Interval[]`.

- [ ] **Step 1: Write the types file**

Create `src/core/work-digest/types.ts`:

```ts
/** A half-open-ish activity interval in epoch milliseconds (end >= start). */
export interface Interval {
  readonly start: number;
  readonly end: number;
}

/** One session's in-day message timestamps plus its resolved topic. */
export interface SessionActivity {
  readonly sessionId: string;
  readonly topic: string;
  readonly timestampsMs: ReadonlyArray<number>;
}

/** Attention: active minutes attributed to one topic. `meta` is an opaque
 *  extension seam (Section 7.1 of the design) — NLM core never reads it. */
export interface TopicShare {
  readonly topic: string;
  readonly activeMinutes: number;
  readonly share: number;
  readonly meta?: Record<string, unknown>;
}

export interface FocusStats {
  readonly contextSwitches: number;
  readonly longestBlockMin: number;
  readonly deepWorkRatio: number;
  readonly projectsTouched: number;
}

export interface ProgressStats {
  readonly decisions: ReadonlyArray<string>;
  readonly openLoops: ReadonlyArray<string>;
}

export interface Coverage {
  readonly sessions: number;
  readonly activeTimeMeasured: number;
  readonly activeTimeSkipped: number;
}

export interface WorkDigest {
  readonly date: string;
  readonly idleThresholdMin: number;
  readonly scopeNote: string;
  readonly coverage: Coverage;
  readonly activeMinutes: number;
  readonly byTopic: ReadonlyArray<TopicShare>;
  readonly focus: FocusStats;
  readonly progress: ProgressStats;
}
```

- [ ] **Step 2: Write the failing test**

Create `tests/unit/core/work-digest/active-spans.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { activeSpans } from "../../../../src/core/work-digest/active-spans.js";

const m = (min: number) => min * 60_000;

describe("activeSpans", () => {
  it("returns no spans for an empty input", () => {
    expect(activeSpans([], 5)).toEqual([]);
  });

  it("returns a zero-length span for a single message", () => {
    expect(activeSpans([1000], 5)).toEqual([{ start: 1000, end: 1000 }]);
  });

  it("keeps messages within the idle threshold in one span", () => {
    const ts = [0, m(3), m(5)];
    expect(activeSpans(ts, 5)).toEqual([{ start: 0, end: m(5) }]);
  });

  it("splits on a gap larger than the threshold", () => {
    const ts = [0, m(2), m(20), m(22)];
    expect(activeSpans(ts, 5)).toEqual([
      { start: 0, end: m(2) },
      { start: m(20), end: m(22) },
    ]);
  });

  it("treats a gap exactly at the threshold as still active", () => {
    expect(activeSpans([0, m(5)], 5)).toEqual([{ start: 0, end: m(5) }]);
  });

  it("sorts unsorted input before computing", () => {
    expect(activeSpans([m(5), 0, m(2)], 5)).toEqual([{ start: 0, end: m(5) }]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run test -- tests/unit/core/work-digest/active-spans.test.ts`
Expected: FAIL — cannot find module `active-spans.js`.

- [ ] **Step 4: Write minimal implementation**

Create `src/core/work-digest/active-spans.ts`:

```ts
import type { Interval } from "./types.js";

/**
 * Collapse a session's message timestamps into activity intervals. Consecutive
 * messages no more than `idleThresholdMin` apart belong to the same span; a
 * larger gap means the operator was away and starts a new span. A lone message
 * yields a zero-length span (it marks activity but adds no minutes).
 */
export function activeSpans(
  timestampsMs: ReadonlyArray<number>,
  idleThresholdMin: number,
): Interval[] {
  const ts = [...timestampsMs].sort((a, b) => a - b);
  if (ts.length === 0) return [];
  const gapMs = idleThresholdMin * 60_000;
  const spans: Interval[] = [];
  let start = ts[0]!;
  let prev = ts[0]!;
  for (let i = 1; i < ts.length; i++) {
    const t = ts[i]!;
    if (t - prev <= gapMs) {
      prev = t;
    } else {
      spans.push({ start, end: prev });
      start = t;
      prev = t;
    }
  }
  spans.push({ start, end: prev });
  return spans;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test -- tests/unit/core/work-digest/active-spans.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck`
Expected: clean.

```bash
git add src/core/work-digest/types.ts src/core/work-digest/active-spans.ts tests/unit/core/work-digest/active-spans.test.ts
git commit -m "feat(work-digest): WorkDigest types + activeSpans (message-gap intervals)"
```

---

### Task 2: `mergeIntervals`

**Files:**
- Create: `src/core/work-digest/merge-active.ts`
- Test: `tests/unit/core/work-digest/merge-active.test.ts`

**Interfaces:**
- Consumes: `Interval` from `./types.js`.
- Produces: `mergeIntervals(intervals: ReadonlyArray<Interval>): { merged: Interval[]; totalMinutes: number }`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/core/work-digest/merge-active.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mergeIntervals } from "../../../../src/core/work-digest/merge-active.js";

const m = (min: number) => min * 60_000;

describe("mergeIntervals", () => {
  it("returns empty + 0 minutes for no intervals", () => {
    expect(mergeIntervals([])).toEqual({ merged: [], totalMinutes: 0 });
  });

  it("merges two overlapping intervals into one (no double-count)", () => {
    const r = mergeIntervals([
      { start: 0, end: m(30) },
      { start: m(20), end: m(40) },
    ]);
    expect(r.merged).toEqual([{ start: 0, end: m(40) }]);
    expect(r.totalMinutes).toBe(40);
  });

  it("keeps disjoint intervals separate and sums their minutes", () => {
    const r = mergeIntervals([
      { start: 0, end: m(10) },
      { start: m(20), end: m(35) },
    ]);
    expect(r.merged).toEqual([
      { start: 0, end: m(10) },
      { start: m(20), end: m(35) },
    ]);
    expect(r.totalMinutes).toBe(25);
  });

  it("merges touching intervals (start == prior end)", () => {
    const r = mergeIntervals([
      { start: 0, end: m(10) },
      { start: m(10), end: m(15) },
    ]);
    expect(r.merged).toEqual([{ start: 0, end: m(15) }]);
    expect(r.totalMinutes).toBe(15);
  });

  it("absorbs a nested interval", () => {
    const r = mergeIntervals([
      { start: 0, end: m(60) },
      { start: m(10), end: m(20) },
    ]);
    expect(r.merged).toEqual([{ start: 0, end: m(60) }]);
    expect(r.totalMinutes).toBe(60);
  });

  it("sorts unsorted input before merging", () => {
    const r = mergeIntervals([
      { start: m(20), end: m(40) },
      { start: 0, end: m(25) },
    ]);
    expect(r.merged).toEqual([{ start: 0, end: m(40) }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- tests/unit/core/work-digest/merge-active.test.ts`
Expected: FAIL — cannot find module `merge-active.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/core/work-digest/merge-active.ts`:

```ts
import type { Interval } from "./types.js";

/**
 * Union overlapping/touching activity intervals into a single wall-clock
 * timeline so concurrently-supervised agents are not double-counted, and
 * report the total active minutes of that timeline.
 */
export function mergeIntervals(
  intervals: ReadonlyArray<Interval>,
): { merged: Interval[]; totalMinutes: number } {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  for (const iv of sorted) {
    const last = merged[merged.length - 1];
    if (last && iv.start <= last.end) {
      if (iv.end > last.end) merged[merged.length - 1] = { start: last.start, end: iv.end };
    } else {
      merged.push({ start: iv.start, end: iv.end });
    }
  }
  const totalMinutes = merged.reduce((t, iv) => t + (iv.end - iv.start) / 60_000, 0);
  return { merged, totalMinutes };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- tests/unit/core/work-digest/merge-active.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` — clean.

```bash
git add src/core/work-digest/merge-active.ts tests/unit/core/work-digest/merge-active.test.ts
git commit -m "feat(work-digest): mergeIntervals — wall-clock active timeline, no double-count"
```

---

### Task 3: topic provider

**Files:**
- Create: `src/core/work-digest/topics.ts`
- Test: `tests/unit/core/work-digest/topics.test.ts`

**Interfaces:**
- Produces: `TopicInput { entities: ReadonlyArray<string>; label: string }`; `TopicProvider = (input: TopicInput) => string`; `defaultTopicProvider: TopicProvider`; `aliasTopicProvider(map: Record<string,string>): TopicProvider`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/core/work-digest/topics.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { defaultTopicProvider, aliasTopicProvider } from "../../../../src/core/work-digest/topics.js";

describe("defaultTopicProvider", () => {
  it("uses the first entity, normalized (trim + lowercase)", () => {
    expect(defaultTopicProvider({ entities: ["  NLM-Memory ", "fts5"], label: "x" })).toBe("nlm-memory");
  });

  it("falls back to uncategorized with no entity", () => {
    expect(defaultTopicProvider({ entities: [], label: "x" })).toBe("uncategorized");
  });

  it("falls back to uncategorized when the first entity is blank", () => {
    expect(defaultTopicProvider({ entities: ["   "], label: "x" })).toBe("uncategorized");
  });
});

describe("aliasTopicProvider", () => {
  it("maps a known entity to its label", () => {
    const p = aliasTopicProvider({ pgvector: "NLM", fts5: "NLM" });
    expect(p({ entities: ["pgvector"], label: "x" })).toBe("NLM");
  });

  it("is case-insensitive on the map key", () => {
    const p = aliasTopicProvider({ PgVector: "NLM" });
    expect(p({ entities: ["PGVECTOR"], label: "x" })).toBe("NLM");
  });

  it("falls through to the normalized entity when unmapped", () => {
    const p = aliasTopicProvider({ pgvector: "NLM" });
    expect(p({ entities: ["GOAT"], label: "x" })).toBe("goat");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- tests/unit/core/work-digest/topics.test.ts`
Expected: FAIL — cannot find module `topics.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/core/work-digest/topics.ts`:

```ts
/** The minimal session view a topic provider sees. Extensions (e.g. NLOS) can
 *  key on entities and/or label to impose their own taxonomy. */
export interface TopicInput {
  readonly entities: ReadonlyArray<string>;
  readonly label: string;
}

export type TopicProvider = (input: TopicInput) => string;

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

/** NLM-core default: the session's first classified entity, normalized. */
export const defaultTopicProvider: TopicProvider = (input) => {
  const first = input.entities[0];
  return first && first.trim() ? normalize(first) : "uncategorized";
};

/** NLM-core optional: group entities into labels via an operator-supplied map.
 *  The same interface an extension uses to supply a function/taxonomy map. */
export function aliasTopicProvider(map: Record<string, string>): TopicProvider {
  const norm: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) norm[normalize(k)] = v;
  return (input) => {
    const base = defaultTopicProvider(input);
    return norm[base] ?? base;
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- tests/unit/core/work-digest/topics.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` — clean.

```bash
git add src/core/work-digest/topics.ts tests/unit/core/work-digest/topics.test.ts
git commit -m "feat(work-digest): pluggable topic provider (default + alias map seam)"
```

---

### Task 4: `attribute`

**Files:**
- Create: `src/core/work-digest/attribute.ts`
- Test: `tests/unit/core/work-digest/attribute.test.ts`

**Interfaces:**
- Consumes: `Interval`, `SessionActivity`, `TopicShare`, `FocusStats` from `./types.js`.
- Produces: `attribute(merged: ReadonlyArray<Interval>, sessions: ReadonlyArray<SessionActivity>, opts: { deepBlockMin: number }): { byTopic: TopicShare[]; focus: FocusStats }`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/core/work-digest/attribute.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { attribute } from "../../../../src/core/work-digest/attribute.js";
import type { Interval, SessionActivity } from "../../../../src/core/work-digest/types.js";

const m = (min: number) => min * 60_000;

describe("attribute", () => {
  it("returns zeros for an empty timeline", () => {
    const r = attribute([], [], { deepBlockMin: 25 });
    expect(r.byTopic).toEqual([]);
    expect(r.focus).toEqual({ contextSwitches: 0, longestBlockMin: 0, deepWorkRatio: 0, projectsTouched: 0 });
  });

  it("attributes a single block to its only session and reports one deep block", () => {
    const merged: Interval[] = [{ start: 0, end: m(40) }];
    const sessions: SessionActivity[] = [
      { sessionId: "a", topic: "nlm", timestampsMs: [0, m(10), m(40)] },
    ];
    const r = attribute(merged, sessions, { deepBlockMin: 25 });
    expect(r.byTopic).toEqual([{ topic: "nlm", activeMinutes: 40, share: 1 }]);
    expect(r.focus).toEqual({ contextSwitches: 0, longestBlockMin: 40, deepWorkRatio: 1, projectsTouched: 1 });
  });

  it("counts a context switch between two adjacent single-topic blocks", () => {
    const merged: Interval[] = [
      { start: 0, end: m(30) },
      { start: m(40), end: m(50) },
    ];
    const sessions: SessionActivity[] = [
      { sessionId: "a", topic: "nlm", timestampsMs: [0, m(30)] },
      { sessionId: "b", topic: "client", timestampsMs: [m(40), m(50)] },
    ];
    const r = attribute(merged, sessions, { deepBlockMin: 25 });
    expect(r.byTopic).toEqual([
      { topic: "nlm", activeMinutes: 30, share: 0.75 },
      { topic: "client", activeMinutes: 10, share: 0.25 },
    ]);
    expect(r.focus.contextSwitches).toBe(1);
    expect(r.focus.longestBlockMin).toBe(30);
    expect(r.focus.projectsTouched).toBe(2);
    // only the 30-min block clears deepBlockMin=25
    expect(r.focus.deepWorkRatio).toBe(0.75);
  });

  it("picks the dominant session by message count when sessions overlap a block", () => {
    const merged: Interval[] = [{ start: 0, end: m(20) }];
    const sessions: SessionActivity[] = [
      { sessionId: "a", topic: "nlm", timestampsMs: [0, m(5), m(10), m(15)] },
      { sessionId: "b", topic: "client", timestampsMs: [m(12)] },
    ];
    const r = attribute(merged, sessions, { deepBlockMin: 25 });
    expect(r.byTopic).toEqual([{ topic: "nlm", activeMinutes: 20, share: 1 }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- tests/unit/core/work-digest/attribute.test.ts`
Expected: FAIL — cannot find module `attribute.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/core/work-digest/attribute.ts`:

```ts
import type { Interval, SessionActivity, TopicShare, FocusStats } from "./types.js";

const round1 = (n: number): number => Math.round(n * 10) / 10;
const round2 = (n: number): number => Math.round(n * 100) / 100;

function countIn(ts: ReadonlyArray<number>, iv: Interval): number {
  let n = 0;
  for (const t of ts) if (t >= iv.start && t <= iv.end) n++;
  return n;
}

/**
 * Attribute each merged active interval to a topic and derive attention +
 * focus. v1 uses dominant-session attribution: the whole interval goes to the
 * session with the most messages in it (the bounded simplification over
 * fractional splitting documented in the design). Focus is derived from the
 * ordered, attributed segments: adjacent same-topic segments collapse into
 * blocks; a topic change between blocks is one context switch.
 */
export function attribute(
  merged: ReadonlyArray<Interval>,
  sessions: ReadonlyArray<SessionActivity>,
  opts: { deepBlockMin: number },
): { byTopic: TopicShare[]; focus: FocusStats } {
  const segments: Array<{ topic: string; minutes: number }> = [];
  for (const iv of merged) {
    const minutes = (iv.end - iv.start) / 60_000;
    let best: SessionActivity | undefined;
    let bestN = -1;
    for (const s of sessions) {
      const n = countIn(s.timestampsMs, iv);
      if (n > bestN) {
        bestN = n;
        best = s;
      }
    }
    segments.push({ topic: best ? best.topic : "uncategorized", minutes });
  }

  const totalMin = segments.reduce((t, s) => t + s.minutes, 0);

  const byTopicMap = new Map<string, number>();
  for (const seg of segments) byTopicMap.set(seg.topic, (byTopicMap.get(seg.topic) ?? 0) + seg.minutes);
  const byTopic: TopicShare[] = [...byTopicMap.entries()]
    .map(([topic, mins]) => ({
      topic,
      activeMinutes: round1(mins),
      share: totalMin ? round2(mins / totalMin) : 0,
    }))
    .sort((a, b) => b.activeMinutes - a.activeMinutes);

  const blocks: Array<{ topic: string; minutes: number }> = [];
  for (const seg of segments) {
    const last = blocks[blocks.length - 1];
    if (last && last.topic === seg.topic) last.minutes += seg.minutes;
    else blocks.push({ topic: seg.topic, minutes: seg.minutes });
  }

  const contextSwitches = Math.max(0, blocks.length - 1);
  const longestBlockMin = blocks.reduce((mx, b) => Math.max(mx, b.minutes), 0);
  const deepMin = blocks
    .filter((b) => b.minutes >= opts.deepBlockMin)
    .reduce((t, b) => t + b.minutes, 0);
  const deepWorkRatio = totalMin ? round2(deepMin / totalMin) : 0;

  return {
    byTopic,
    focus: {
      contextSwitches,
      longestBlockMin: round1(longestBlockMin),
      deepWorkRatio,
      projectsTouched: byTopicMap.size,
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- tests/unit/core/work-digest/attribute.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` — clean.

```bash
git add src/core/work-digest/attribute.ts tests/unit/core/work-digest/attribute.test.ts
git commit -m "feat(work-digest): attribute merged time to topics + focus stats"
```

---

### Task 5: `composeWorkDigest`

**Files:**
- Create: `src/core/work-digest/compose-work-digest.ts`
- Test: `tests/unit/core/work-digest/compose-work-digest.test.ts`

**Interfaces:**
- Consumes: `WorkDigest` from `./types.js`.
- Produces: `composeWorkDigest(d: WorkDigest): string`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/core/work-digest/compose-work-digest.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { composeWorkDigest } from "../../../../src/core/work-digest/compose-work-digest.js";
import type { WorkDigest } from "../../../../src/core/work-digest/types.js";

const base: WorkDigest = {
  date: "2026-06-23",
  idleThresholdMin: 5,
  scopeNote: "Agent-assisted active time. Excludes meetings and work without an agent.",
  coverage: { sessions: 12, activeTimeMeasured: 10, activeTimeSkipped: 2 },
  activeMinutes: 372,
  byTopic: [
    { topic: "nlm", activeMinutes: 180, share: 0.48 },
    { topic: "client", activeMinutes: 84, share: 0.22 },
  ],
  focus: { contextSwitches: 14, longestBlockMin: 95, deepWorkRatio: 0.58, projectsTouched: 5 },
  progress: { decisions: ["option B push to pull"], openLoops: ["validate B over a real week"] },
};

describe("composeWorkDigest", () => {
  it("renders the scope note, attention, focus, and progress", () => {
    const out = composeWorkDigest(base);
    expect(out).toContain("2026-06-23");
    expect(out).toContain("Agent-assisted active time");
    expect(out).toContain("nlm");
    expect(out).toContain("48%");
    expect(out).toContain("context switches: 14");
    expect(out).toContain("option B push to pull");
    expect(out).toContain("validate B over a real week");
  });

  it("shows a coverage line when some sessions were skipped", () => {
    expect(composeWorkDigest(base)).toContain("2 session");
  });

  it("never emits an em dash in operator-facing copy", () => {
    expect(composeWorkDigest(base)).not.toContain("—");
  });

  it("renders an explicit empty-day line when there is no active time", () => {
    const empty: WorkDigest = {
      ...base,
      activeMinutes: 0,
      byTopic: [],
      coverage: { sessions: 0, activeTimeMeasured: 0, activeTimeSkipped: 0 },
      focus: { contextSwitches: 0, longestBlockMin: 0, deepWorkRatio: 0, projectsTouched: 0 },
      progress: { decisions: [], openLoops: [] },
    };
    expect(composeWorkDigest(empty)).toContain("no agent-assisted work recorded");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- tests/unit/core/work-digest/compose-work-digest.test.ts`
Expected: FAIL — cannot find module `compose-work-digest.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/core/work-digest/compose-work-digest.ts`:

```ts
import type { WorkDigest } from "./types.js";

function hours(min: number): string {
  return (min / 60).toFixed(1) + "h";
}

/** Render a WorkDigest as the shared operator-facing text. No em dashes. */
export function composeWorkDigest(d: WorkDigest): string {
  const lines: string[] = [];
  lines.push(`DAILY WORK RECAP - ${d.date}`);
  lines.push(`(${d.scopeNote})`);
  lines.push("");

  if (d.activeMinutes <= 0) {
    lines.push("no agent-assisted work recorded for this day.");
    return lines.join("\n");
  }

  const skipped =
    d.coverage.activeTimeSkipped > 0
      ? `   (${d.coverage.activeTimeSkipped} session(s): active-time not measured)`
      : "";
  lines.push(`~${hours(d.activeMinutes)} active across ${d.coverage.sessions} sessions, ${d.focus.projectsTouched} projects${skipped}`);
  lines.push("");

  lines.push("ATTENTION");
  for (const t of d.byTopic) {
    const pct = Math.round(t.share * 100) + "%";
    lines.push(`  ${t.topic}: ${pct} (${hours(t.activeMinutes)})`);
  }
  lines.push("");

  lines.push("FOCUS");
  lines.push(
    `  longest block: ${Math.round(d.focus.longestBlockMin)} min   ` +
      `context switches: ${d.focus.contextSwitches}   ` +
      `deep-work: ${Math.round(d.focus.deepWorkRatio * 100)}%`,
  );
  lines.push("");

  lines.push("PROGRESS");
  lines.push(
    d.progress.decisions.length > 0
      ? `  decided (${d.progress.decisions.length}): ${d.progress.decisions.join("; ")}`
      : "  decided: none recorded",
  );
  lines.push(
    d.progress.openLoops.length > 0
      ? `  open loops (${d.progress.openLoops.length}): ${d.progress.openLoops.join("; ")}`
      : "  open loops: none",
  );

  return lines.join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- tests/unit/core/work-digest/compose-work-digest.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` — clean.

```bash
git add src/core/work-digest/compose-work-digest.ts tests/unit/core/work-digest/compose-work-digest.test.ts
git commit -m "feat(work-digest): compose WorkDigest to operator-facing text"
```

---

### Task 6: `listByDateRange` on the SessionStore

**Files:**
- Modify: `src/ports/session-store.ts` (add method to the interface, near `getByIds`)
- Modify: `src/core/storage/sqlite-session-store.ts` (add method after `getByIds`)
- Modify: `src/core/storage/pg-session-store.ts` (add method after `getByIds`)
- Test: `tests/unit/core/storage/list-by-date-range.test.ts`

**Interfaces:**
- Produces: `SessionStore.listByDateRange(fromIso: string, toIso: string): Promise<ReadonlyArray<Session>>` — sessions whose lifespan `[started_at, ended_at|open]` overlaps `[fromIso, toIso)`, body omitted, ordered by `started_at` ascending.

- [ ] **Step 1: Add the method to the port**

In `src/ports/session-store.ts`, immediately after the `getByIds(...)` signature, add:

```ts
  /**
   * Sessions whose lifespan [started_at, ended_at or open] overlaps the
   * half-open window [fromIso, toIso). Body is omitted (callers that need it
   * fetch by id). Ordered by started_at ascending. Used by the work-digest.
   */
  listByDateRange(fromIso: string, toIso: string): Promise<ReadonlyArray<Session>>;
```

- [ ] **Step 2: Write the failing test**

Create `tests/unit/core/storage/list-by-date-range.test.ts`. (Mirror the construction used by other sqlite-session-store tests in `tests/unit/core/storage/` for `MIGRATIONS_DIR` and a temp db; the assertions are the new behavior.)

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../../../../src/core/storage/sqlite-storage.js";

// Matches the construction used by other sqlite-session-store tests.
const MIGRATIONS_DIR = resolve(__dirname, "../../../../migrations");

async function insert(storage: SqliteStorage, id: string, startedAt: string, endedAt: string | null) {
  await storage.sessions.insertSession({
    id, runtime: "claude-code", runtimeSessionId: id, startedAt, endedAt,
    durationMin: null, label: id, summary: "", body: "", status: "closed",
    transcriptKind: "claude-code-jsonl", transcriptPath: `/tmp/${id}.jsonl`,
    transcriptOffset: null, transcriptLength: null,
    entities: [], decisions: [], openQuestions: [],
  });
}

describe("SqliteSessionStore.listByDateRange", () => {
  let tmp: string;
  let storage: SqliteStorage;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "nlm-lbdr-"));
    storage = SqliteStorage.create({ dbPath: join(tmp, "c.sqlite"), migrationsDir: MIGRATIONS_DIR });
    await storage.init();
  });
  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns sessions whose lifespan overlaps the window", async () => {
    await insert(storage, "in_day", "2026-06-23T10:00:00.000Z", "2026-06-23T11:00:00.000Z");
    await insert(storage, "before", "2026-06-21T10:00:00.000Z", "2026-06-21T11:00:00.000Z");
    await insert(storage, "spanning", "2026-06-22T23:00:00.000Z", "2026-06-23T01:00:00.000Z");
    await insert(storage, "open_old", "2026-06-20T10:00:00.000Z", null);

    const got = await storage.sessions.listByDateRange(
      "2026-06-23T00:00:00.000Z",
      "2026-06-24T00:00:00.000Z",
    );
    const ids = got.map((s) => s.id).sort();
    // in_day overlaps; spanning overlaps at the start of the day; open_old is
    // still open so it overlaps; before does not.
    expect(ids).toEqual(["in_day", "open_old", "spanning"]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run test -- tests/unit/core/storage/list-by-date-range.test.ts`
Expected: FAIL — `listByDateRange` is not a function (or type error).

- [ ] **Step 4: Implement on SqliteSessionStore**

In `src/core/storage/sqlite-session-store.ts`, after the `getByIds` method, add:

```ts
  async listByDateRange(fromIso: string, toIso: string): Promise<ReadonlyArray<Session>> {
    const rows = this.db
      .prepare<[string, string], Omit<SessionRow, "body">>(`
        SELECT id, runtime, runtime_session_id, started_at, ended_at, duration_min,
               label, summary, status, transcript_kind, transcript_path
        FROM sessions
        WHERE started_at < ? AND (ended_at IS NULL OR ended_at >= ?)
        ORDER BY started_at ASC
      `)
      .all(toIso, fromIso);
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const entitiesByIdMap = this.loadEntities(ids);
    const markersByIdMap = this.loadMarkers(ids);
    const overlay = loadActionOverlay(this.db);
    return rows.map((r) =>
      this.rowToSession({ ...r, body: null }, entitiesByIdMap, markersByIdMap, overlay),
    );
  }
```

- [ ] **Step 5: Implement on PgSessionStore**

In `src/core/storage/pg-session-store.ts`, after the `getByIds` method, add (mirrors its `getByIds` hydration):

```ts
  async listByDateRange(fromIso: string, toIso: string): Promise<ReadonlyArray<Session>> {
    const result = await this.pool.query<Omit<SessionRow, "body">>(
      `SELECT id, runtime, runtime_session_id, started_at, ended_at, duration_min,
              label, summary, status, transcript_kind, transcript_path
       FROM sessions
       WHERE started_at < $1 AND (ended_at IS NULL OR ended_at >= $2)
       ORDER BY started_at ASC`,
      [toIso, fromIso],
    );
    if (result.rows.length === 0) return [];
    const ids = result.rows.map((r) => r.id);
    const [entitiesMap, markersMap] = await Promise.all([
      this.loadEntities(ids),
      this.loadMarkers(ids),
    ]);
    return result.rows.map((r) => rowToSession({ ...r, body: null }, entitiesMap, markersMap));
  }
```

- [ ] **Step 6: Run test + typecheck**

Run: `npm run test -- tests/unit/core/storage/list-by-date-range.test.ts` — PASS.
Run: `npm run typecheck` — clean (confirms both stores satisfy the port).

- [ ] **Step 7: Commit**

```bash
git add src/ports/session-store.ts src/core/storage/sqlite-session-store.ts src/core/storage/pg-session-store.ts tests/unit/core/storage/list-by-date-range.test.ts
git commit -m "feat(store): listByDateRange — sessions overlapping a day window"
```

---

### Task 7: `readTranscriptTimestamps`

**Files:**
- Create: `src/core/work-digest/read-transcript-timestamps.ts`
- Test: `tests/unit/core/work-digest/read-transcript-timestamps.test.ts`

**Interfaces:**
- Produces: `readTranscriptTimestamps(path: string, fromMs: number, toMs: number): number[]` — sorted epoch-ms of messages whose timestamp is in `[fromMs, toMs)`; `[]` on a missing/unreadable file.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/core/work-digest/read-transcript-timestamps.test.ts`:

```ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readTranscriptTimestamps } from "../../../../src/core/work-digest/read-transcript-timestamps.js";

describe("readTranscriptTimestamps", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "nlm-ttx-")); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  const from = Date.parse("2026-06-23T00:00:00.000Z");
  const to = Date.parse("2026-06-24T00:00:00.000Z");

  it("returns sorted in-window timestamps and skips out-of-window + garbage", () => {
    const p = join(tmp, "t.jsonl");
    writeFileSync(p, [
      JSON.stringify({ timestamp: "2026-06-23T10:00:00.000Z" }),
      JSON.stringify({ timestamp: "2026-06-22T10:00:00.000Z" }), // before window
      "not json",                                                  // garbage
      JSON.stringify({ nope: true }),                              // no timestamp
      JSON.stringify({ timestamp: "2026-06-23T08:00:00.000Z" }),
    ].join("\n"));
    expect(readTranscriptTimestamps(p, from, to)).toEqual([
      Date.parse("2026-06-23T08:00:00.000Z"),
      Date.parse("2026-06-23T10:00:00.000Z"),
    ]);
  });

  it("returns [] for a missing file", () => {
    expect(readTranscriptTimestamps(join(tmp, "missing.jsonl"), from, to)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- tests/unit/core/work-digest/read-transcript-timestamps.test.ts`
Expected: FAIL — cannot find module `read-transcript-timestamps.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/core/work-digest/read-transcript-timestamps.ts`:

```ts
import { readFileSync } from "node:fs";

/**
 * Extract message timestamps (epoch ms) from a transcript JSONL file, keeping
 * only those within [fromMs, toMs). Best-effort: a missing/unreadable file or
 * an unparseable line yields no timestamps rather than throwing. Accepts the
 * common timestamp fields across runtimes (claude-code/pi use `timestamp`).
 */
export function readTranscriptTimestamps(path: string, fromMs: number, toMs: number): number[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: number[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const tsRaw = obj["timestamp"] ?? obj["ts"] ?? obj["created_at"];
    if (typeof tsRaw !== "string") continue;
    const ms = Date.parse(tsRaw);
    if (!Number.isFinite(ms)) continue;
    if (ms >= fromMs && ms < toMs) out.push(ms);
  }
  out.sort((a, b) => a - b);
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- tests/unit/core/work-digest/read-transcript-timestamps.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` — clean.

```bash
git add src/core/work-digest/read-transcript-timestamps.ts tests/unit/core/work-digest/read-transcript-timestamps.test.ts
git commit -m "feat(work-digest): read in-window transcript message timestamps"
```

---

### Task 8: `buildWorkDigest` loader

**Files:**
- Create: `src/core/work-digest/build-work-digest.ts`
- Test: `tests/integration/work-digest-build.test.ts`

**Interfaces:**
- Consumes: `Session` (`@shared/types.js`); `SessionStore.listByDateRange`; `activeSpans`, `mergeIntervals`, `attribute`, `readTranscriptTimestamps`, `defaultTopicProvider`/`aliasTopicProvider`, and the `WorkDigest`/`SessionActivity` types.
- Produces: `buildWorkDigest(deps: BuildWorkDigestDeps, date: string): Promise<WorkDigest>` where
  `BuildWorkDigestDeps = { store: Pick<SessionStore, "listByDateRange">; topicProvider?: TopicProvider; idleThresholdMin?: number; deepBlockMin?: number; readTimestamps?: (path: string, fromMs: number, toMs: number) => number[] }`.

- [ ] **Step 1: Write the failing test**

Create `tests/integration/work-digest-build.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildWorkDigest } from "../../src/core/work-digest/build-work-digest.js";
import type { Session } from "../../src/shared/types.js";

function session(over: Partial<Session> & { id: string }): Session {
  return {
    id: over.id, runtime: "claude-code", runtimeSessionId: over.id,
    startedAt: "2026-06-23T10:00:00.000Z", endedAt: "2026-06-23T11:00:00.000Z",
    durationMin: null, label: over.label ?? over.id, summary: "", status: "closed",
    transcriptKind: "claude-code-jsonl", transcriptPath: `/fake/${over.id}.jsonl`,
    body: "", entities: over.entities ?? [], decisions: over.decisions ?? [],
    open: over.open ?? [], ...over,
  };
}

const m = (min: number) => Date.parse("2026-06-23T10:00:00.000Z") + min * 60_000;

describe("buildWorkDigest", () => {
  it("computes attention, focus, progress, and coverage from sessions + transcripts", async () => {
    const sessions: Session[] = [
      session({ id: "a", entities: ["nlm"], decisions: ["chose option B"], open: ["validate B"] }),
      session({ id: "b", entities: ["goat"], decisions: [] }),
      session({ id: "c", entities: ["nlm"], transcriptPath: null }), // skipped
    ];
    const timestamps: Record<string, number[]> = {
      "/fake/a.jsonl": [m(0), m(10), m(30)], // 30 min, topic nlm
      "/fake/b.jsonl": [m(40), m(50)],       // 10 min, topic goat
    };
    const digest = await buildWorkDigest(
      {
        store: { listByDateRange: async () => sessions },
        readTimestamps: (path) => timestamps[path] ?? [],
        idleThresholdMin: 5,
        deepBlockMin: 25,
      },
      "2026-06-23",
    );

    expect(digest.date).toBe("2026-06-23");
    expect(digest.activeMinutes).toBe(40);
    expect(digest.byTopic).toEqual([
      { topic: "nlm", activeMinutes: 30, share: 0.75 },
      { topic: "goat", activeMinutes: 10, share: 0.25 },
    ]);
    expect(digest.coverage).toEqual({ sessions: 3, activeTimeMeasured: 2, activeTimeSkipped: 1 });
    expect(digest.progress.decisions).toContain("chose option B");
    expect(digest.progress.openLoops).toContain("validate B");
    expect(digest.scopeNote).toContain("Agent-assisted active time");
  });

  it("returns a valid empty digest for a day with no activity", async () => {
    const digest = await buildWorkDigest(
      { store: { listByDateRange: async () => [] }, readTimestamps: () => [] },
      "2026-06-23",
    );
    expect(digest.activeMinutes).toBe(0);
    expect(digest.byTopic).toEqual([]);
    expect(digest.coverage.sessions).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- tests/integration/work-digest-build.test.ts`
Expected: FAIL — cannot find module `build-work-digest.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/core/work-digest/build-work-digest.ts`:

```ts
import type { Session } from "@shared/types.js";
import type { SessionStore } from "@ports/session-store.js";
import { activeSpans } from "./active-spans.js";
import { mergeIntervals } from "./merge-active.js";
import { attribute } from "./attribute.js";
import { readTranscriptTimestamps } from "./read-transcript-timestamps.js";
import { defaultTopicProvider, type TopicProvider } from "./topics.js";
import type { Interval, SessionActivity, WorkDigest } from "./types.js";

const SCOPE_NOTE = "Agent-assisted active time. Excludes meetings and work without an agent.";

export interface BuildWorkDigestDeps {
  readonly store: Pick<SessionStore, "listByDateRange">;
  readonly topicProvider?: TopicProvider;
  readonly idleThresholdMin?: number;
  readonly deepBlockMin?: number;
  readonly readTimestamps?: (path: string, fromMs: number, toMs: number) => number[];
}

/** Local-midnight window for `date` (YYYY-MM-DD) in the process timezone. */
function dayWindow(date: string): { fromMs: number; toMs: number; fromIso: string; toIso: string } {
  const from = new Date(`${date}T00:00:00`);
  const to = new Date(from);
  to.setDate(to.getDate() + 1);
  return { fromMs: from.getTime(), toMs: to.getTime(), fromIso: from.toISOString(), toIso: to.toISOString() };
}

export async function buildWorkDigest(deps: BuildWorkDigestDeps, date: string): Promise<WorkDigest> {
  const idleThresholdMin = deps.idleThresholdMin ?? 5;
  const deepBlockMin = deps.deepBlockMin ?? 25;
  const topicProvider = deps.topicProvider ?? defaultTopicProvider;
  const readTs = deps.readTimestamps ?? readTranscriptTimestamps;

  const { fromMs, toMs, fromIso, toIso } = dayWindow(date);
  const sessions = await deps.store.listByDateRange(fromIso, toIso);

  const activities: SessionActivity[] = [];
  const allSpans: Interval[] = [];
  const decisions = new Set<string>();
  const openLoops = new Set<string>();
  let measured = 0;
  let skipped = 0;

  for (const s of sessions) {
    for (const d of s.decisions) decisions.add(d);
    for (const o of s.open) openLoops.add(o);

    const timestampsMs = s.transcriptPath ? readTs(s.transcriptPath, fromMs, toMs) : [];
    if (timestampsMs.length === 0) {
      skipped++;
      continue;
    }
    measured++;
    const topic = topicProvider({ entities: s.entities, label: s.label });
    activities.push({ sessionId: s.id, topic, timestampsMs });
    for (const span of activeSpans(timestampsMs, idleThresholdMin)) allSpans.push(span);
  }

  const { merged, totalMinutes } = mergeIntervals(allSpans);
  const { byTopic, focus } = attribute(merged, activities, { deepBlockMin });

  return {
    date,
    idleThresholdMin,
    scopeNote: SCOPE_NOTE,
    coverage: { sessions: sessions.length, activeTimeMeasured: measured, activeTimeSkipped: skipped },
    activeMinutes: Math.round(totalMinutes * 10) / 10,
    byTopic,
    focus,
    progress: { decisions: [...decisions], openLoops: [...openLoops] },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- tests/integration/work-digest-build.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` — clean.

```bash
git add src/core/work-digest/build-work-digest.ts tests/integration/work-digest-build.test.ts
git commit -m "feat(work-digest): loader — sessions + transcripts -> WorkDigest"
```

---

### Task 9: `work_summary` MCP tool

**Files:**
- Modify: `src/mcp/server.ts` (add `workSummaryHandler` + register the tool; extend `McpDeps`)
- Test: `tests/integration/mcp-work-summary.test.ts`

**Interfaces:**
- Consumes: `buildWorkDigest`, `composeWorkDigest`, `BuildWorkDigestDeps`.
- Produces: `workSummaryHandler(deps: McpDeps, input: { date?: string }): Promise<ToolResult>`; `McpDeps.workDigest?: BuildWorkDigestDeps` (optional; when absent the tool returns a clear "not available" message).

- [ ] **Step 1: Write the failing test**

Create `tests/integration/mcp-work-summary.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { workSummaryHandler, type McpDeps } from "../../src/mcp/server.js";
import type { Session } from "../../src/shared/types.js";

const m = (min: number) => Date.parse("2026-06-23T10:00:00.000Z") + min * 60_000;

function sess(id: string, entities: string[]): Session {
  return {
    id, runtime: "claude-code", runtimeSessionId: id,
    startedAt: "2026-06-23T10:00:00.000Z", endedAt: "2026-06-23T11:00:00.000Z",
    durationMin: null, label: id, summary: "", status: "closed",
    transcriptKind: "claude-code-jsonl", transcriptPath: `/fake/${id}.jsonl`,
    body: "", entities, decisions: [], open: [],
  };
}

describe("workSummaryHandler", () => {
  it("returns the composed digest text for a date", async () => {
    const deps = {
      workDigest: {
        store: { listByDateRange: async () => [sess("a", ["nlm"])] },
        readTimestamps: () => [m(0), m(10), m(30)],
        idleThresholdMin: 5,
        deepBlockMin: 25,
      },
    } as unknown as McpDeps;

    const res = await workSummaryHandler(deps, { date: "2026-06-23" });
    const text = (res.content?.[0] as { text: string }).text;
    expect(text).toContain("DAILY WORK RECAP - 2026-06-23");
    expect(text).toContain("nlm");
  });

  it("returns a clear message when work-digest is not wired", async () => {
    const res = await workSummaryHandler({} as McpDeps, { date: "2026-06-23" });
    const text = (res.content?.[0] as { text: string }).text;
    expect(text.toLowerCase()).toContain("not available");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- tests/integration/mcp-work-summary.test.ts`
Expected: FAIL — `workSummaryHandler` is not exported.

- [ ] **Step 3: Extend `McpDeps` and add the handler**

In `src/mcp/server.ts`: add the imports near the other `@core` imports:

```ts
import { buildWorkDigest, type BuildWorkDigestDeps } from "@core/work-digest/build-work-digest.js";
import { composeWorkDigest } from "@core/work-digest/compose-work-digest.js";
```

Add to the `McpDeps` interface (alongside the other optional deps):

```ts
  /** Wire to enable the work_summary tool (operator daily work digest). */
  readonly workDigest?: BuildWorkDigestDeps;
```

Add the handler (next to `recallSessionsHandler`):

`ok(data)` runs `data` through the TOON/JSON formatter, which is wrong for an
already-formatted digest string, so add a plain-text helper `okText` next to
`ok` (the existing `ok`/`err`/`ToolResult` are at the top of `server.ts`;
`ToolResult` is `{ content: { type: "text"; text: string }[]; isError?: boolean }`):

```ts
function okText(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}
```

Then the handler (next to `recallSessionsHandler`):

```ts
export async function workSummaryHandler(
  deps: McpDeps,
  input: { date?: string },
): Promise<ToolResult> {
  if (!deps.workDigest) {
    return okText("work_summary is not available in this deployment.");
  }
  try {
    const date = input.date ?? localToday();
    const digest = await buildWorkDigest(deps.workDigest, date);
    return okText(composeWorkDigest(digest));
  } catch (e) {
    return err(e);
  }
}

/** YYYY-MM-DD for "today" in the process timezone. */
function localToday(): string {
  const d = new Date();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mo}-${da}`;
}
```

- [ ] **Step 4: Register the tool in `createMcpServer`**

In `createMcpServer`, after the `recall_sessions` registration, add:

```ts
  server.registerTool(
    "work_summary",
    {
      title: "Daily work summary",
      description:
        "The operator's agent-assisted work recap for a day: where attention went (active time by topic), focus quality (context switches, longest block), and progress (decisions, open loops). Optional `date` (YYYY-MM-DD); defaults to today.",
      inputSchema: {
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("Day to summarize, YYYY-MM-DD. Defaults to today."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => workSummaryHandler(deps, args) as never,
  );
```

- [ ] **Step 5: Run test + typecheck**

Run: `npm run test -- tests/integration/mcp-work-summary.test.ts` — PASS.
Run: `npm run typecheck` — clean.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/server.ts tests/integration/mcp-work-summary.test.ts
git commit -m "feat(mcp): work_summary tool — operator daily work digest (agent pull)"
```

---

### Task 10: `nlm work-digest` CLI + daemon wiring

**Files:**
- Modify: `src/cli/nlm.ts` (add the `work-digest` command; wire `workDigest` into the daemon's `McpDeps`)
- Test: `tests/integration/cli-work-digest.test.ts`

**Interfaces:**
- Consumes: `buildStack()` (provides `store`), `buildWorkDigest`, `composeWorkDigest`.
- Produces: a `nlm work-digest [--date YYYY-MM-DD]` command printing the composed digest; the daemon's `createApp`/`mcpDeps` now carries `workDigest`.

- [ ] **Step 1: Write the failing test (pure CLI helper)**

To keep the command testable without spawning the process, factor the date-resolution into a tiny exported helper and test it. Create `tests/integration/cli-work-digest.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { resolveDigestDate } from "../../src/cli/nlm.js";

describe("resolveDigestDate", () => {
  it("returns the provided date when valid", () => {
    expect(resolveDigestDate("2026-06-23")).toBe("2026-06-23");
  });

  it("throws on a malformed date", () => {
    expect(() => resolveDigestDate("June 23")).toThrow();
  });

  it("returns a YYYY-MM-DD string for today when omitted", () => {
    expect(resolveDigestDate(undefined)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- tests/integration/cli-work-digest.test.ts`
Expected: FAIL — `resolveDigestDate` is not exported.

- [ ] **Step 3: Add the helper + command**

In `src/cli/nlm.ts`, add the imports near the top:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { buildWorkDigest } from "@core/work-digest/build-work-digest.js";
import { composeWorkDigest } from "@core/work-digest/compose-work-digest.js";
import { defaultTopicProvider, aliasTopicProvider, type TopicProvider } from "@core/work-digest/topics.js";
```

(Skip any import already present in the file.)

Export the helper (top-level, near the other small helpers like `port()`):

```ts
export function resolveDigestDate(date: string | undefined): string {
  if (date !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error(`invalid --date "${date}"; expected YYYY-MM-DD`);
    }
    return date;
  }
  const d = new Date();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mo}-${da}`;
}

function workDigestEnv(): { idleThresholdMin: number; deepBlockMin: number } {
  const idle = Number.parseInt(process.env["NLM_WORK_IDLE_THRESHOLD_MIN"] ?? "5", 10);
  const deep = Number.parseInt(process.env["NLM_WORK_DEEP_BLOCK_MIN"] ?? "25", 10);
  return {
    idleThresholdMin: Number.isFinite(idle) && idle > 0 ? idle : 5,
    deepBlockMin: Number.isFinite(deep) && deep > 0 ? deep : 25,
  };
}

/** Optional ~/.nlm/work-topics.json alias map -> topic provider; default if absent/bad. */
function loadTopicProvider(): TopicProvider {
  try {
    const raw = readFileSync(join(homedir(), ".nlm", "work-topics.json"), "utf8");
    const map = JSON.parse(raw) as Record<string, string>;
    return aliasTopicProvider(map);
  } catch {
    return defaultTopicProvider;
  }
}
```

Add the command (next to the other `program.command(...)` definitions):

```ts
program
  .command("work-digest")
  .description("Print the operator's agent-assisted work recap for a day")
  .option("-d, --date <date>", "day to summarize, YYYY-MM-DD (default: today)")
  .action(async (opts) => {
    const date = resolveDigestDate(opts.date);
    const { storage, store } = await buildStack();
    try {
      const digest = await buildWorkDigest(
        { store, topicProvider: loadTopicProvider(), ...workDigestEnv() },
        date,
      );
      console.log(composeWorkDigest(digest));
    } finally {
      await storage.close();
    }
  });
```

- [ ] **Step 4: Wire `workDigest` into the daemon's MCP deps**

In `src/cli/nlm.ts` `start` action, in the `mcpDeps` object passed to `createApp` (the block gated on `hasMcpToken`), add the `workDigest` dep so the running daemon's `work_summary` tool works (the topic provider is resolved once at boot; editing `work-topics.json` takes effect on the next daemon restart, like other config):

```ts
              workDigest: { store, topicProvider: loadTopicProvider(), ...workDigestEnv() },
```

- [ ] **Step 5: Run test + typecheck**

Run: `npm run test -- tests/integration/cli-work-digest.test.ts` — PASS.
Run: `npm run typecheck` — clean.

- [ ] **Step 6: Full suite + build + live smoke**

Run: `npm run test` — green except the known pre-existing #365 citation failure.
Run: `npm run build:server` — clean.
Live smoke (real corpus): `node dist/cli/nlm.js work-digest --date <a-recent-active-day>` and confirm it prints a sane recap (active hours under ~12h, topics that match what you worked on, coverage line if any sessions were skipped). Verify the active hours are not the inflated duration-sum (a day should read single-digit hours, not 80+).

- [ ] **Step 7: Commit**

```bash
git add src/cli/nlm.ts tests/integration/cli-work-digest.test.ts
git commit -m "feat(cli): nlm work-digest + wire work_summary into the daemon"
```

---

## After all tasks

- Restart the daemon (`node dist/cli/nlm.js restart`) so the live `work_summary` MCP tool and the daemon wiring pick up the new code.
- Squash-merge the Phase 1 branch to main per repo convention; push.
- The design's Phase 2 (Telegram/email push) and Phase 3 (UI chart) get their own plans referencing the same `WorkDigest` core. The extension seams (`byTopic[].meta`, range/trend, anonymized export) remain unbuilt until an extension needs them.
