# Work Digest — operator time-feedback loop (design)

> Date: 2026-06-23. Status: approved design, pre-implementation.
> Goal: give the NLM operator a trustworthy daily feedback loop on how their
> working time was spent — where attention went, whether the day made progress
> or churned, and how focused it was — delivered through whichever surface the
> operator prefers (agent pull, Telegram/email push, or the UI).

## 1. Problem

NLM already captures every AI working session across runtimes, but offers the
operator no reflection on their own day. The existing `nlm digest` reports
*recall* health (is memory being used), not *work* (how the day went). The
operator wants: "how was my time used today as it relates to working?"

The naive answer — sum session durations — is a lie. Evidence from the live
corpus (2026-06-23):

- `sessions.duration_min` is **session lifespan, not work time**: avg 119 min,
  **max 11,492 min (191 hours)** — a session left open for 8 days.
- Summing yesterday's session durations = 87.4h; merging their
  `[started_at, ended_at]` windows collapses to a single **37.6h block** because
  long-lived sessions (background agents, forgotten-open tabs) span the whole day.
- Therefore any model built on `duration_min` inherits that noise. Capping only
  shrinks the lie.

The reliable signal is **transcript message cadence**: Claude Code transcripts
have 100% per-message timestamp coverage; pi transcripts carry timestamps too.
Active work is the run of messages with small inter-message gaps; large gaps are
the operator being away.

## 2. Scope and honesty boundary

NLM sees **agent-assisted work only**. It cannot see meetings, manual coding
without an agent, or thinking away from the keyboard. The digest is explicitly
"your agent-assisted active time," and every surface states that boundary. It
never claims to be a full timesheet, and never reports absolute hours derived
from `duration_min`.

This feature ships in **NLM core** and is useful standalone to any solo
operator who never touches consulting. NLOS (Whtnxt's consulting methodology)
is an **extension that consumes** this generic core, not part of it. NLM core
never models a "function," an "autonomy tier," or a "client." The boundary and
the extension seams are specified in Section 7.1; this section's only job is to
keep the core generic.

Runtime coverage for active-time:
- **claude-code**: full (timestamped JSONL, locally readable).

Runtime coverage for active-time:
- **claude-code**: full (timestamped JSONL, locally readable).
- **pi**: full (timestamped, locally readable).
- **hermes**: transcripts run on the Mac Pro and are not reliably readable from
  the operator's machine. Hermes sessions contribute to session/marker counts
  but are flagged "active-time not measured." The digest reports this coverage
  gap rather than silently undercounting.

## 3. The core: `WorkDigest`

A pure data structure computed once per day, rendered identically by every
surface. NLM's hexagonal pattern: a pure core, thin delivery adapters (mirrors
the existing recall digest's `compose.ts` core + CLI/Telegram adapter split).

```
WorkDigest {
  date: string                     // YYYY-MM-DD, operator's timezone
  idleThresholdMin: number         // gap threshold used (default 5)
  scopeNote: string                // the honesty boundary, human-readable
  coverage: {
    sessions: number               // sessions on this date
    activeTimeMeasured: number      // sessions whose active-time was computed
    activeTimeSkipped: number       // sessions skipped (unreadable transcript / hermes)
  }
  activeMinutes: number            // total real wall-clock active minutes (merged, no double-count)
  byTopic: Array<{                 // ATTENTION
    topic: string
    activeMinutes: number
    share: number                  // 0..1 of activeMinutes
    meta?: Record<string, unknown> // EXTENSION SEAM (Section 7.1): opaque to NLM,
                                    // populated/read by extensions (NLOS puts
                                    // {tier, roiTarget} here). Empty in Phase 1.
  }>
  focus: {                         // FOCUS QUALITY
    contextSwitches: number        // topic transitions across the day's active spans
    longestBlockMin: number        // longest single-topic contiguous active span
    deepWorkRatio: number          // share of active time in single-topic blocks >= deepBlockMin
    projectsTouched: number
  }
  progress: {                      // PROGRESS
    decisions: string[]            // decision markers created in today's sessions
    openLoops: string[]            // open-question markers from today, surfaced for tomorrow
  }
}
```

## 4. Active-time computation (the method)

The crux. Computed in three pure stages so each is independently testable.

### 4a. Per-session active spans (`active-spans.ts`)
Input: a session's sorted message timestamps + `idleThresholdMin`.
Output: maximal runs of messages where consecutive gaps <= threshold, emitted as
`[start, end]` activity intervals. Gaps > threshold split the run (the operator
was away). A lone message yields a zero-length point (contributes 0 active min).

### 4b. Cross-session merge (`merge-active.ts`)
The operator often supervises several agents at once (claude-code + pi
concurrently), so per-session active spans **overlap in wall-clock**. Summing
them double-counts. So: pool all sessions' active spans for the day, sort, and
**merge overlapping intervals** into a single wall-clock active timeline.
`activeMinutes` = total length of the merged timeline. This is honest wall-clock
active time: two agents supervised in the same 30 minutes count as 30 minutes,
not 60.

### 4c. Topic attribution (`attribute.ts`)
For each merged active interval, attribute its minutes to a topic. When a single
session covers the interval, use its topic. When multiple sessions overlap the
interval, attribute to the **dominant session** (most messages in that window).
v1 uses dominant-session attribution rather than fractional splitting — simpler,
and the error is bounded (it only mis-attributes genuinely-concurrent minutes,
and to a real co-active topic). `byTopic` aggregates attributed minutes; `focus`
is derived from the ordered, attributed timeline (a topic change between adjacent
active intervals = one context switch; the longest single-topic run = the deepest
block; deep-work ratio uses `deepBlockMin`, default 25).

### Topic derivation (a pluggable provider — extension seam)
Topic resolution goes through a **topic provider**: `(session) -> topic label`.
This is the seam an extension uses to impose its own taxonomy without NLM
knowing what the taxonomy means (Section 7.1).

- **Default provider (NLM core):** a session's topic is its **first classified
  entity** — NLM already stores an ordered entity list per session, first =
  primary — normalized (trim + lowercase); no entity falls into `uncategorized`.
- **Alias-map provider (NLM core, optional):** an operator-editable map at
  `~/.nlm/work-topics.json` (`{ "pgvector": "NLM", "fts5": "NLM", ... }`) groups
  granular entities into labels; absent the file, the default provider is used.
- **Extension providers (e.g. NLOS):** NLOS supplies its "core functions" map
  through the same provider interface, so active-time rolls up to functions.
  NLM core treats the returned label as an opaque string either way.

This keeps the core honest and simple while making the taxonomy an injection
point, not a hardcoded assumption.

## 5. Composer (`compose-work-digest.ts`)

Pure: `WorkDigest -> string`. Produces the shared human-readable recap used by
the agent-pull and push surfaces. Sketch:

```
DAILY WORK RECAP — 2026-06-23  (agent-assisted active time; excludes meetings / agent-free work)

  ~6.2h active across 12 sessions, 5 projects   (2 hermes sessions: active-time not measured)

  ATTENTION
    NLM memory ......... 48%   (3.0h)
    GOAT client ........ 22%   (1.4h)
    content / F-word ... 18%   (1.1h)
    scattered / admin .. 12%   (0.7h)

  FOCUS
    longest block: 95 min (NLM)    context switches: 14    deep-work: 58%

  PROGRESS
    decided (6): option B push->pull; runtime attribution on both pull paths; ...
    open loops for tomorrow (4): validate B over a real week; #365 citation test; ...
```

No em dashes in operator-facing copy per house style; the sample above uses them
only for spec readability. Final copy uses plain separators.

## 6. Delivery adapters

All four render the same `WorkDigest`. Built in phases (Section 8).

- **Agent pull** — MCP tool `work_summary(date?)` in `mcp/server.ts`. Builds the
  `WorkDigest` for the date (default: today) and returns the composed text.
  Serves "the operator asks their agent how the day went." Cheapest surface: no
  scheduling, no template, no UI.
- **Push (Telegram / email)** — `nlm work-digest [--date] [--telegram|--email]`,
  composing over `WorkDigest`. Reuses the existing Telegram push and digest
  infrastructure. Cadence default: **end-of-day** ("here is how today went"),
  distinct from the existing morning recall digest. Channel and cadence are
  operator config; the operator chooses Telegram or email (or both).
- **UI chart** — `GET /api/work-digest?date=` returns the `WorkDigest` JSON; the
  desktop UI renders an attention breakdown (share by topic) and a focus
  timeline (active blocks across the day). Biggest build; last phase.

## 7. Modules and layering

```
src/core/work-digest/
  active-spans.ts        pure: timestamps + threshold -> activity intervals
  merge-active.ts        pure: intervals[] -> merged wall-clock timeline + total
  attribute.ts           pure: merged timeline + session topics -> byTopic + focus
  topics.ts              pure: topic provider (default + alias-map) -> topic label
  build-work-digest.ts   loader: gather sessions/markers (SessionStore) + read
                         transcripts (fs via transcript_path) -> calls the pure
                         stages -> WorkDigest. The only module with I/O.
  compose-work-digest.ts pure: WorkDigest -> text
```

Adapters depend on `build-work-digest` + `compose-work-digest`; the pure core
depends on nothing but its inputs. `core/` never imports an adapter. Transcript
reading reuses the existing per-runtime transcript handling where practical; the
loader owns all filesystem and store access so the computation stays pure.

### 7.1 Layering: NLM core vs extensions (e.g. NLOS)

NLM core owns the **generic** operator time-feedback above. It is standalone-
useful and knows nothing about consulting. An extension (NLOS) consumes the core
through a small set of stable seams and adds domain meaning. The dependency is
**one-way: extension -> NLM**. NLM core never imports an extension, never models
a "function," "autonomy tier," or "client," and never has a code path that
differs because NLOS is or isn't present.

Discipline (YAGNI): build only the seams that would be *breaking to add later*;
design-for the rest and build the machinery when an extension actually needs it.

| Seam | NLM core (generic) | Extension (NLOS) adds | Phase |
|---|---|---|---|
| **Topic provider** (`topics.ts`) | `(session) -> label`; default = first entity; optional alias map | Supplies its core-functions map via the same interface | 1 (seam) |
| **Pass-through topic meta** (`byTopic[].meta`) | Opaque `Record<string,unknown>`, never interpreted, carried through compose untouched | Writes `{tier, roiTarget}`; its own renderer reads it | 1 (shape only, empty) |
| **Consumable `WorkDigest`** | Versioned struct via `GET /api/work-digest` + `work_summary` MCP | Reads the contract, never internals | 1 |
| **Range / trend queries** | Generic multi-day aggregation of `WorkDigest` (any operator wants weekly trends) | Computes the per-function ROI *delta* over the engagement | Forward |
| **Anonymized aggregate export** | NLM owns the privacy boundary: an opt-in hook emitting anonymized, schema-level aggregates only | Owns the destination + the cross-instance/cross-client rollup (the data moat) | Forward |

The NLOS value (human-side ROI proof, the operator's learning layer, the cross-
client benchmark of human-time-reclaimed-by-tier-by-vertical) is built entirely
in the extension on top of these seams. Phase 1 ships the core plus the three
Phase-1 seams; it adds no NLOS concept and no NLOS-only code path. This keeps the
open-core split clean: NLOS rides on NLM Core / Teams without NLM depending on it.

## 8. Phasing

1. **Core + agent-pull.** `work-digest/*` pure stages + `build-work-digest`
   loader + `compose-work-digest` + the `work_summary` MCP tool + an
   `nlm work-digest [--date]` CLI that prints the text. Ships the feedback loop
   immediately and validates active-time against real days before investing in
   delivery polish.
2. **Push adapter.** `--telegram` / `--email` flags + an end-of-day cron;
   operator config for channel and cadence. Reuses existing digest/Telegram infra.
3. **UI charts.** `GET /api/work-digest` + the desktop attention/focus views.

Each phase is its own branch -> PR -> squash-merge, with its own spec-derived
implementation plan. This document is the spec for Phase 1; phases 2 and 3 get
their own plans referencing this design.

## 9. Configuration

- `NLM_WORK_IDLE_THRESHOLD_MIN` (default 5) — gap above which the operator is
  "away"; gaps at or below count as active.
- `NLM_WORK_DEEP_BLOCK_MIN` (default 25) — minimum single-topic contiguous active
  span counted toward `deepWorkRatio` and "deep work."
- `~/.nlm/work-topics.json` (optional) — entity -> project-label alias map.
- Push channel/cadence config (Phase 2): operator selects Telegram, email, or
  both, and end-of-day (default) or morning.

## 10. Testing

- **active-spans** (pure): synthetic timestamp arrays -> known intervals. Edge
  cases: single message (0 active), all-idle (every gap > threshold -> all points),
  exact-threshold boundary, empty.
- **merge-active** (pure): overlapping intervals from two "sessions" merge to the
  union (no double-count); adjacent-but-disjoint stay separate; nested intervals.
- **attribute** (pure): dominant-session attribution on overlaps; context-switch
  count on an ordered topic sequence; longest-block and deep-work-ratio math.
- **topics** (pure): alias-map rollup; missing map falls back to raw entity;
  no-entity -> uncategorized.
- **compose** (pure): a fixed `WorkDigest` -> stable text snapshot; coverage-gap
  line appears when `activeTimeSkipped > 0`; scope note always present.
- **build-work-digest** (integration): a fixture day (sessions + small transcript
  files + markers) -> end-to-end `WorkDigest` with expected totals.
- **work_summary MCP tool** (integration): returns the composed text for a date.

All via TDD: failing test first, `npm run test` + `npm run typecheck` green.

## 11. Edge cases and risks

- **Unreadable / missing transcript** -> skip that session's active-time, count it
  in `coverage.activeTimeSkipped`, still use its markers. Never fail the digest.
- **Hermes (remote transcripts)** -> the common skipped case; reported in coverage,
  not silently dropped.
- **Sub-agent transcripts** (Claude Code spawns subagents with their own JSONL) ->
  their active spans are real concurrent work; the cross-session merge already
  de-duplicates the overlap, and attribution rolls them into the dominant topic
  (usually the parent's). No special-casing needed beyond including them in the
  session set.
- **Clock/timezone** -> "day" boundaries use the operator's timezone
  (America/Chicago); a session is "on" a date if it has any active span within
  that local day. Cross-midnight sessions split at the boundary.
- **Empty day** -> a valid `WorkDigest` with `activeMinutes: 0` and an explicit
  "no agent-assisted work recorded" composed line.
- **Attribution error on heavy multitasking** -> dominant-session attribution can
  mis-assign genuinely-concurrent minutes; bounded (only co-active topics, only
  overlapping minutes) and acceptable for v1. Fractional splitting is a later
  refinement if the operator finds the rollups off.

## 12. Out of scope (v1)

- "Closed threads" / resolution detection (needs open-question -> resolution
  linkage; today's progress is decisions-made + open-loops-surfaced).
- Cross-day trends, weekly rollups, streaks (the range/trend seam is designed-for
  in Section 7.1; the machinery is built when first needed).
- Non-active-time productivity inference (NLM only sees what it sees).
- A built-in project taxonomy beyond the optional alias map.
- **All NLOS extension scope** (Section 7.1): function/autonomy-tier mapping,
  human-side ROI proof, the anonymized cross-client benchmark. These live in the
  extension and consume the core's seams; none of them are NLM-core work, and no
  NLM-core code path may reference them.
