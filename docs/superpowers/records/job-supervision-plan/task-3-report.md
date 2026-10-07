# Task 3 report — digest section + docs

## Digest wiring

`composeDigest` (`src/core/digest/compose.ts`) is pure and testable, matching
the existing section pattern (`formatOutcomeCoverage`, `formatPrecision`):
`ComposeInput` gained an optional `job?: JobSnapshot | null` field, and one
new `Jobs:` line is inserted right after the tier-B outcome-coverage line.

Since `digest.ts` is a separate CLI process that talks to the daemon over
HTTP (not a direct `JobSupervisor` reference), the only way it can reach the
snapshot is `GET /api/health`'s existing `job` field (Task 2's addition).
`runDigest` (`src/cli/digest.ts`) fetches it as a **best-effort** call after
the main `stats`/`recent`/`dataset` gate — a health-fetch failure falls back
to `job: null` rather than failing the whole digest, consistent with how
`precision` and `outcomeCoverage` are already treated in that function.

### Line format by state

- `running` / `stalled`: `Jobs: reprocess 412/664, last advance 3m ago` (or
  `stalled at 412/664, ...`). If `lastAdvanceAt` is still null (child just
  spawned, no `[i/n]` line seen yet), renders `no progress yet` instead of a
  bogus timestamp.
- `completed`: `Jobs: reprocess completed 664/664`.
- `stopped`: `Jobs: reprocess stopped at 200/664`.
- `exhausted`: `Jobs: reprocess gave up after 3 fruitless restarts (412/664
  processed)` — this reuses `job-alert.ts`'s `buildJobAlertEvent` wording
  verbatim rather than re-deriving it, so the alert and the digest describe
  the same exhausted run identically. Per Task 2's own comment, `restarts`
  at exhaustion already counts the refused final attempt; "fruitless"
  frames the count as restarts that led nowhere, not restarts still ahead,
  which is the misread this phrasing exists to foreclose. Singular/plural
  handled (`1 fruitless restart` vs `3 fruitless restarts`).
- `idle` and the null/absent case render identically: `Jobs: no active job`.
  This covers both "never started" and "daemon restarted mid-run" for free
  — `JobSupervisor` holds no state across process restarts (by design, per
  the plan), so a fresh instance reports `idle` the same as one that never
  ran. No persistence was added.

## Docs

- README env-table row for `NLM_JOB_STALL_MINUTES` (default `20`), placed
  next to the two `NLM_ALERT_WEBHOOK*` rows since it's the same
  alerting/supervision cluster.
- REST API table: extended the existing `/api/health` row's Purpose column
  with the `job` block shape and its idle/null semantics — same table cell
  style as the existing `update: {current, latest, behind}` fragment.
- Also added `POST`/`DELETE /api/jobs/reprocess` rows to that same table.
  These were Task 2's routes but were never documented anywhere in the
  repo (verified via grep before adding) — leaving them undocumented while
  describing the `job` block that they produce would be a real gap in the
  "wherever /api/health's payload fields are documented" home the brief
  named, so I added them as a bounded extension of the same table edit.
- "Daily digest" prose paragraph now mentions the `Jobs:` line alongside
  the other reported fields.
- No CHANGELOG entry (controller's job, per the brief).

## TDD

Test-first: 10 new `it` blocks added to
`tests/unit/core/digest/compose.test.ts` under a `describe("Jobs line", ...)`
block, covering every `JobState` value plus the null/absent/no-progress-yet
edge cases, confirmed red (10 failing) before implementing `formatJobLine` /
`formatAgo` in `compose.ts`.

## Test evidence

```
$ npx vitest run tests/unit/core/digest/compose.test.ts
 Test Files  1 passed (1)
      Tests  19 passed (19)      # 9 pre-existing + 10 new

$ npx tsc --noEmit
(clean, no output)

$ npm test -- --run 2>&1 | tail -8
 Test Files  27-28 failed | 267-268 passed | 1 skipped (296)
      Tests  7-8 failed | 2324-2325 passed | 228 skipped (2560)
```

The full-suite run flickered by exactly one file/test between two
consecutive runs (267/268 passed files, 2324/2325 passed tests). Diffing the
failing-file list against both runs confirms it's the same closed set every
time: every `*.pg.test.ts` file plus `supersedence-cycle-guard.test.ts`
(pg-only despite its name, all failing on `ECONNREFUSED 127.0.0.1:54329` —
no live Postgres in this environment). None of those files touch digest or
jobs code; the flicker is Postgres connection-retry timing noise across
runs, not a regression. Passing-test count rose by exactly 10 over Task 2's
2315 baseline (before accounting for the ±1 pg flicker), matching the 10
new tests added here.

## Commits

- `a90d3e1` `feat(jobs): add Jobs line to daily digest for reprocess supervision`
- `da5d9f8` `docs(jobs): document NLM_JOB_STALL_MINUTES and the /api/health job block`

## Self-review (git diff 8fd13ba..HEAD)

Reviewed the full diff (`README.md`, `src/cli/digest.ts`,
`src/core/digest/compose.ts`, `tests/unit/core/digest/compose.test.ts`,
260 lines). Points checked and resolved during review, not left open:

- `formatJobLine`'s switch is exhaustive over all six `JobState` values
  (`idle` and `default` both fall through to the same "no active job"
  line) — no silent gap if a state is added later without updating this
  function; it would just render the fallback line rather than throwing.
- `formatAgo` is only ever called with a non-null `lastAdvanceAt` (guarded
  by the ternary at each call site), so its parameter type is `string`, not
  `string | null` — no redundant null-handling inside it.
- The `/api/health` fetch in `digest.ts` is intentionally **not** folded
  into the existing `Promise.all([stats, recent, dataset])` — that trio's
  failure is the "daemon unreachable" gate for the whole digest, and
  folding a best-effort field into it would make a `/api/health` hiccup
  wrongly report the entire daemon as down. Kept as a separate sequential
  best-effort await, matching how `precision` and `outcomeCoverage` are
  already fetched in this same function (not parallelized either) — no new
  inconsistency introduced.
- Confirmed `/api/health` is `Host-only` (skips the Bearer/Origin gate
  entirely, per `installLocalOnlyMiddleware` in `src/http/app.ts`), so the
  existing `hookAuthHeaders(...)` call on this fetch is harmless whether or
  not a token is configured.
- README pipe-escaping (`\|` inside the `job: {...} | null` table cell)
  matches the existing convention used one row below it
  (`?mode=keyword\|semantic\|hybrid`).
- No dead code, no leftover debug output, no CHANGELOG touched.

No findings required a fix pass.

## Concerns / notes

- The two new README rows for `POST`/`DELETE /api/jobs/reprocess` are
  slightly outside this task's two-item doc scope as literally listed in
  the brief (env row + health job block), but they're the same table cell
  edit's natural extension and were a real pre-existing gap from Task 2.
  Flagging in case the controller wants them split out or reverted.
- Digest's `/api/health` call adds one extra sequential daemon round-trip
  to `nlm digest`'s runtime (health is lightweight, so this is not expected
  to be perceptible, but noting it since it wasn't there before).

## Final-review fix wave

Three findings from the job-supervision final review, fixed against
`src/core/jobs/job-supervisor.ts` and its consumers.

### 1. CRITICAL — spawn failure stranded the supervisor at "running"

`start()` set `state = "running"` and then called `spawnAndWire()`
unguarded; a synchronous `spawnChild` throw (EMFILE/ENOMEM/bad binary)
left `state:"running"`, `child:null` forever. `checkStall` bails on
`!this.child`, so no stall ever fired; `/api/health` reported a live run
that didn't exist; `POST /api/jobs/reprocess` 409'd ("already active")
indefinitely since the run never looked terminal. The identical hole
existed at the restart path in `handleExit` — the old code's `onExit`
wrapper already caught a *thrown handler*, but `handleExit` itself called
`this.spawnAndWire()` unguarded at the very end, after already having set
`state = "running"`.

Fix: both call sites now wrap `spawnAndWire()` in try/catch.

- `start()`: on a thrown spawn, sets `child = null`, `state = "exhausted"`,
  fires a new `{kind: "spawn_failed"}` event (extends `JobSupervisorEvent`,
  `AlertEventData.reason`, `JobAlertEventData.reason`, all backward-
  compatible additions to existing unions), then **rethrows** the original
  error. Decision: `start()` keeps its existing contract of throwing on
  spawn failure — the HTTP route (`POST /api/jobs/reprocess` in
  `src/http/app.ts`, already documented as "the required catch point") is
  unchanged and still turns the throw into a 500. The fix is that by the
  time it throws, `snapshot()` already reads a terminal state, so the next
  `start()` call is not refused with "already active" and the next POST
  does not 409 forever.
- `handleExit`'s respawn: same wrap, but no rethrow — `handleExit` runs off
  an async `onExit` callback with no caller waiting on a return value, so
  it logs via the injected `log` port and stops. `restarts`/`restartsTotal`
  are left at their pre-attempt values since the respawn never happened.

Reused the existing "exhausted" `JobState` for the landed terminal state
(no new state value), distinguishing "never got off the ground" from "ran
out of restart budget" only in the *event kind* (`spawn_failed` vs.
`exhausted`) and its alert/digest wording — cheap to add, per the brief,
since it slots into the existing discriminated unions without touching the
`JobState` enum or any of its five-state consumers.

Tests (`tests/unit/core/jobs/job-supervisor.test.ts`): one for a sync
throw on the initial `start()`, one for a sync throw on a mid-run
respawn triggered by `emitExit`. Both assert: terminal state (never
`"running"`), the correct event fired with untouched restart counters,
and — the invariant that actually matters — that a subsequent `start()`
call succeeds afterward (no false "already active" lockout).

### 2. IMPORTANT — exhausted-restarts off-by-one

`handleExit` did `this.restarts += 1` *then* checked
`this.restarts > this.maxRestartsWithoutProgress`. With the default cap of
3, the 4th no-progress exit incremented `restarts` to 4 before comparing
`4 > 3`, so the emitted event (and everything downstream — the
`nlm.job.stalled` alert, the digest's "gave up after N fruitless
restarts" line) reported 4 when only 3 real respawns had happened. Task 1
and Task 2's own progress notes had already flagged this as a known,
deferred off-by-one.

Fix: flipped to check-before-increment — `if (this.restarts >=
this.maxRestartsWithoutProgress)` fires exhaustion (and skips the
increment/respawn entirely) using the restarts count already on the
books, so an exhausted run's reported `restarts` always equals the number
of respawns that actually occurred. No behavioral change to *when*
exhaustion trips (still exactly `maxRestartsWithoutProgress` respawns,
still no extra spawn) — only the reported number changed, along with
`src/core/alerts/types.ts`'s doc comment, which now correctly states the
count "is always exactly the configured cap" (previously false; it was
cap+1).

Updated the existing exhaustion and progress-reset tests in
`job-supervisor.test.ts`, the end-to-end alert-emission test
(`job-alert-emission.test.ts`), and the digest compose fixtures to the
corrected count.

### 3. IMPORTANT — OOM restart churn invisible (restartsTotal)

`restarts` resets to 0 on every progress advance (by design, so the cap
measures *consecutive* no-progress restarts) — which means a run that
OOM-restarts 40 times while still grinding through items between crashes
reports `restarts: 0` on every operator-facing surface, indistinguishable
from a run that's never had a hiccup.

Added `restartsTotal`: a lifetime counter, incremented on every
*successful* respawn (not on a failed spawn attempt — see finding 1),
reset only by a fresh `start()`, never by progress. Threaded through:

- `JobSnapshot.restartsTotal` (so `/api/health`'s `job` block carries it)
- `JobSupervisorEventBase.restartsTotal` (all three event kinds —
  `stalled`/`exhausted`/`spawn_failed`)
- `JobAlertEventData.restartsTotal` (the `nlm.job.stalled` webhook payload,
  via `buildJobAlertEvent`)
- `composeDigest`'s running-line only, per the brief: `Jobs: reprocess
  412/664, last advance 3m ago, 2 restarts`, suffix omitted when
  `restartsTotal` is 0, singularized at exactly 1

Updated `README.md`: the `/api/health` row now explains `restarts` vs.
`restartsTotal`, and the digest prose paragraph mentions the running-line
suffix.

## Test evidence

```
$ npx tsc --noEmit
(clean, no output — pre-existing tsconfig.test.json union-narrowing
errors in job-alert.test.ts/drift-transition.test.ts confirmed present
at baseline da5d9f8 via `git stash`, unrelated to this fix wave, left
untouched)

$ npx vitest run tests/unit/core/jobs/job-supervisor.test.ts \
    tests/unit/http/jobs-routes.test.ts \
    tests/unit/core/alerts/job-alert.test.ts \
    tests/unit/core/jobs/job-alert-emission.test.ts \
    tests/unit/core/digest/compose.test.ts \
    tests/integration/http.test.ts
 Test Files  6 passed (6)
      Tests  134 passed (134)

$ npm test -- --run
 Test Files  27 failed | 268 passed | 1 skipped (296)
      Tests  7 failed | 2332 passed | 228 skipped (2567)
```

All 27 failing files are `*.pg.test.ts` plus the pg-only
`supersedence-cycle-guard.test.ts`, every one failing on
`ECONNREFUSED 127.0.0.1:54329` (no live Postgres in this environment) —
the same pre-existing exception called out in the fix-wave brief. None
touch jobs/alerts/digest/http code.

## Commits

- `46ab291` `fix(jobs): stop spawn failures from stranding the supervisor at "running"`
- `e482033` `test(jobs): cover spawn-failure recovery, the restarts fix, and restartsTotal`
- `e0632a2` `docs(jobs): document restartsTotal and the spawn_failed alert reason`
