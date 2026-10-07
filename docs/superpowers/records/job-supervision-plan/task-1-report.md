# Task 1 report — core JobSupervisor

## Verified progress-line format

The plan assumed `[N/total] <id> ok`. `src/core/ingest/reprocess.ts` itself never
prints anything — it only calls `opts.onProgress?.(idx, total, sid, status)` on
every branch (`empty_body`, `classify_failed`, `ok`, `ingest_failed`), so
`processed` advances on failures too, not just successes. The actual output line
is written by the CLI wiring in `src/cli/nlm.ts` (`reprocess` command, `-v` flag):

```ts
process.stderr.write(`  [${i}/${n}] ${sid}  ${status}\n`);
```

i.e. two leading spaces, `[i/n]` unpadded, one space, the session id, **two**
spaces, then the status word. The plan's format was close but understated the
leading indent and the double space before status. Since `processed` increments
on every outcome branch, any line matching `[i/n]` is a genuine advance
regardless of the status word that follows — so the parser (`PROGRESS_RE` in
`job-supervisor.ts`) only captures the two numbers and ignores the rest of the
line, which makes it robust to the exact spacing/status vocabulary.

## API surface (`src/core/jobs/job-supervisor.ts`)

- `class JobSupervisor` — constructed with `{ spawnChild, clock, onEvent?, stallMinutes?, maxRestartsWithoutProgress?, stallCheckIntervalMs?, log? }`.
- `start(args: string[]): void` — throws if a run is already `running`/`stalled`.
- `stop(): void` — kills the active child, moves to `"stopped"`; no-op if idle/terminal; idempotent.
- `snapshot(): JobSnapshot` — `{ name: "reprocess", state, processed, total, startedAt, lastAdvanceAt, restarts }`.
- Ports: `SpawnChild = (args: string[]) => ChildHandle` (`{onLine(cb), onExit(cb), kill()}`), `Clock = { now(): number; setInterval(fn, ms): void }`.
- `JobSupervisorEvent` — `{ kind: "stalled" | "exhausted", job: "reprocess", processed, total, restarts, lastAdvanceAt }`, delivered via the optional `onEvent` port.

### `JobState` and the idle representation

`"idle" | "running" | "stalled" | "completed" | "exhausted" | "stopped"`. The
plan's health-block shape only enumerated the last five; `"idle"` is the design
choice noted in the brief as mine to make. It's the state before any `start()`
call — Task 2's `/api/health` mapping can treat `state === "idle"` as the `job:
null` case described in the plan's design section. `"stopped"` (a plan-listed
state, distinct from `"idle"`) is what an explicit `stop()` produces — I
interpreted the required test's plain-English "stop() kills child and idles" as
"returns to a non-active state," not literally `state === "idle"`, since
`"stopped"` is already one of the plan's own five enumerated values and carries
more information (an operator can distinguish "never run" from "somebody
stopped it"). `"completed"` and `"exhausted"` are likewise terminal until the
next `start()` — they persist so Task 3's digest can report the last outcome,
per the plan's "keep last-run summary in supervisor state" note.

### Design choices worth flagging

- **`restarts` = restarts-without-progress, not a lifetime total.** It's the
  exact counter gating exhaustion, reset to 0 by any progress advance. Exposing
  the same value in `snapshot()` and the event payload means there's one source
  of truth and the number directly explains "why exhausted" (it's always the
  cap value, e.g. 4, at the moment `exhausted` fires).
- **"Work remaining" = `code !== 0 || (total > 0 && processed < total)`.** A
  non-clean exit (including a signal-killed child, surfaced as `code === null`)
  always counts as work remaining, even if no progress line was ever seen —
  this is exactly the OOM-before-first-progress-line case the feature exists
  for. A clean exit (`code === 0`) is trusted as completion even when
  `total === 0` (the "0 eligible sessions" no-op case), since reprocess only
  exits 0 after its work loop finishes every item.
- **Restart/spawn counting** (documented in the test names, since the plan
  brief's "no 4th spawn" phrasing was ambiguous about what's being counted): a
  fresh `start()` performs the initial spawn (not itself a restart); "max 3
  restarts without progress" then allows up to 3 more respawns. So 3
  no-progress restarts means 4 total `spawnChild` calls (1 initial + 3
  restarts), and the would-be 4th restart (5th spawn) never happens. Tests
  assert this exact count.
- **Total/processed reflect the current child only**, not a merge across
  respawns. Reprocess's own state file (`~/.nlm/reprocess.state`) makes each
  respawned child skip already-done sessions, so a respawn's own `[i/n]` is
  scoped to its remaining candidate set. The supervisor just mirrors whatever
  the live child reports; it doesn't try to reconstruct a run-lifetime total.
- **Stall check runs on one long-lived interval** started once in the
  constructor (via the injected `Clock.setInterval`, never a real timer) and
  no-ops whenever there's no active child. There's no teardown method — a
  `JobSupervisor` is meant to live for the daemon process's lifetime (same
  posture as `ScanScheduler`), and no other part of the plan calls for
  destroying one mid-process.
- **Never crashes the daemon**: every child-driven callback path
  (`onLine`, `onExit`, the stall-check interval callback, and the `onEvent`
  invocation itself) is wrapped in try/catch and logs via an injectable `log`
  (defaults to `console.error`, same convention as `ScanScheduler`). `start()`
  and `stop()` are synchronous public API calls invoked directly by a caller
  (e.g. an HTTP route in Task 2), so they intentionally still throw/refuse
  rather than swallow — that's the caller's signal to return 409, not a
  crash risk.

## Tests

`tests/unit/core/jobs/job-supervisor.test.ts` — fake spawner (`FakeChild`
records `onLine`/`onExit` callbacks, exposes `emitLine`/`emitExit`) + virtual-time
`FakeClock` (`advance(ms)` fires due `setInterval` callbacks in order, no real
timers). 8 tests, all required cases covered:

1. Normal completion (progress to total, clean exit → `completed`, no restart, no event).
2. Exit with work remaining → respawns with the same args.
3. 3 consecutive no-progress restarts → `exhausted` event, 4 total spawns, no 5th.
4. Progress resets the restart counter (2 restarts used, then an advance, then 3 more needed to exhaust — proving the reset, not just a coincidental cap hit).
5. Stall fires once per episode, doesn't re-fire on further no-progress ticks, and fires again after a recovery + new stall.
6. `stop()` kills the child, transitions to `stopped`, and the child's subsequent `onExit` (as a real child_process would still deliver after being killed) is correctly ignored rather than triggering a respawn; idempotent double-`stop()`.
7. `snapshot()` shape (exact key set + types) verified across all six states: idle, running, stalled, stopped, completed, exhausted.
8. `start()` throws on a concurrent run attempt (bonus, not in the required list but directly implements the brief's "throws/refuses if active").

## Test evidence

```
$ npx tsc --noEmit
(clean, no output)

$ npx vitest run tests/unit/core/jobs/job-supervisor.test.ts
 Test Files  1 passed (1)
      Tests  8 passed (8)

$ npm test -- --run 2>&1 | tail -8
 Test Files  27 failed | 265 passed | 1 skipped (293)
      Tests  7 failed | 2290 passed | 228 skipped (2525)
```

All 27 failed test files are `*.pg.test.ts` (Postgres-connectivity integration
tests — `pg-migrate.pg.test.ts`, `tenancy.pg.test.ts`, `entity-store.pg.test.ts`,
etc.), pre-existing on `cb3d467` per the task instructions and unrelated to this
change; no `job-supervisor` or other unit test regressed.

## Commits

- `0d185d4` `feat(jobs): add core JobSupervisor for reprocess restart/stall supervision`
- `b90a45c` `test(jobs): unit tests for JobSupervisor restart/stall/exhaustion policy`

## Concerns / notes for Task 2

- The real `SpawnChild` adapter needs to turn `child_process.spawn`'s combined
  stdout+stderr into line-buffered `onLine` calls (reprocess's `-v` output goes
  to stderr per the CLI wiring above) and the real `Clock` adapter is a trivial
  `Date.now()` + `setInterval` wrapper — both are thin per the plan's "side-
  effectful spawn adapter thin and unremarkable" instruction, no logic to test.
- Task 2's `/api/health` route will need to decide what `job: null` means given
  my `"idle"` state — I left that mapping to Task 2 as instructed, but flagging
  that `state === "idle"` is the signal to use.
- Not implemented here (by design, Task 2's scope): real spawn adapter, HTTP
  routes, `fireAlert`/`AlertEvent` wiring, CLI `--daemon` flag, digest section.

## Fix pass (post-review)

Task review returned two findings, both addressed:

**CRITICAL — stale child callbacks after stop()+start() corrupt live-run
state / leak processes.** `spawnAndWire`'s `onLine`/`onExit` closures had no
identity check against the child they were registered for. Sequence: `stop()`
sends `kill()` but the child's real exit is still queued → `start()` spawns a
new child B → the old child A's exit finally arrives → `handleExit` treated it
as B's, nulling `this.child` (leaking B — now unmanaged and unkillable),
incrementing `restarts`, and potentially respawning a stray child C on top of
the live run. Fix: `spawnAndWire` now captures the just-spawned child in a
local `const child`, and both `onLine`/`onExit` closures check
`this.child !== child` and return early before calling into
`handleLine`/`handleExit`. Verified the fix is load-bearing, not decorative: I
locally reverted the two guard lines, reran the suite, confirmed the new
regression tests failed exactly as expected (stale exit spawned an unwanted
child, stale line corrupted `total` from 0 to 10 on the live run), then
restored the fix.

Two new regression tests in `job-supervisor.test.ts`:
- `"a stale exit/line from a stopped run's old child cannot touch a new run started after it"` — stop() then start(), then the old child's queued line and exit both arrive; asserts the new run's snapshot and child count are untouched, and that the new run's own child still functions normally afterward.
- `"a stale exit from a mid-run respawn's predecessor cannot double-respawn"` — a duplicate/late second exit delivery from an already-superseded predecessor must not trigger a second respawn.

**IMPORTANT — port interfaces defined inline instead of `src/ports/*.ts`.**
`ChildHandle`, `SpawnChild`, and `Clock` were declared directly in
`job-supervisor.ts`, breaking from every other core module's convention of
importing ports via `@ports/*`. No existing `Clock` port was found to reuse
(confirmed via `ls src/ports/ | grep -i clock`, empty). Relocated to:
- `src/ports/clock.ts` — `Clock` (`now()`, `setInterval(fn, ms)`)
- `src/ports/spawn-child.ts` — `ChildHandle` (`onLine`, `onExit`, `kill`) and `SpawnChild`

`job-supervisor.ts` now does `import type { ChildHandle, SpawnChild } from
"@ports/spawn-child.js"` and `import type { Clock } from "@ports/clock.js"`;
it does not re-export them (no precedent for that in the codebase — consumers,
including the test file, import port types directly from `src/ports/`). Task
2 should build its real `child_process`-backed `SpawnChild` adapter and
`Date.now()`/`setInterval`-backed `Clock` adapter against these two files.

### Test evidence (fix pass)

```
$ npx tsc --noEmit
(clean, no output)

$ npx vitest run tests/unit/core/jobs/job-supervisor.test.ts
 Test Files  1 passed (1)
      Tests  10 passed (10)

$ npm test -- --run 2>&1 | tail -8
 Test Files  27 failed | 265 passed | 1 skipped (293)
      Tests  7 failed | 2292 passed | 228 skipped (2527)
```

Same 27 pre-existing `*.pg.test.ts` failures as before (unchanged, unrelated).
Passing test count rose by exactly 2 (2290 → 2292), matching the 2 new
regression tests. No regressions.

### Commits (fix pass)

- `a53b284` `fix(jobs): guard child callbacks against stale identity, relocate ports`
- `9886d23` `test(jobs): regression coverage for stale child-callback identity`
