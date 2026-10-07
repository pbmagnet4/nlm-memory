# Task 2 report — daemon wiring + HTTP + CLI

## Wiring points

- `src/http/app.ts` — `HttpDeps.jobSupervisor?: Pick<JobSupervisor, "start" | "stop" | "snapshot">`
  (narrowed to the three methods the routes need, so unit tests can pass a
  plain fake instead of a real `JobSupervisor`, which would otherwise pull
  in real spawnChild/clock ports). `registerJobRoutes` mounts
  `POST`/`DELETE /api/jobs/reprocess`; `registerHealthRoute` adds a `job`
  field.
- `src/cli/nlm.ts`'s `start` command constructs the one `JobSupervisor`
  instance for the daemon's lifetime, right before `createApp(...)`, and
  passes it in as `jobSupervisor`.
- `onEvent: (event) => { void fireAlert(buildJobAlertEvent(event)); }` —
  fire-and-forget. Safe both ways: `fireAlert` never throws (best-effort
  delivery, pre-existing contract), and `JobSupervisor` itself
  catches/logs anything an `onEvent` callback throws
  (`job-supervisor.ts`'s `emitEvent`).

## Route shapes

```
POST /api/jobs/reprocess
  body (optional): { args?: string[] }   — array of strings, passed
                                            verbatim as argv entries
  202 { ok: true, snapshot: JobSnapshot }        — started
  400 { error }                                  — body not JSON, or args
                                                    not an array of strings
  409 { error, snapshot: JobSnapshot }           — a run is already active
                                                    (supervisor.start()
                                                    threw "reprocess job
                                                    already active")
  500 { error }                                  — any OTHER thrown error
                                                    (e.g. a real spawn
                                                    failure) — caught here
                                                    so it can never reach
                                                    Hono's default handler
                                                    and crash the daemon
  503 { error }                                  — no jobSupervisor wired

DELETE /api/jobs/reprocess
  200 { ok: true, snapshot: JobSnapshot }        — stop() called (no-op-safe
                                                    if idle/terminal already)
  503 { error }                                  — no jobSupervisor wired
```

Both methods are in `HOSTED_GATED_ROUTES` as `LOCAL` (single-operator
process supervision has no per-tenant meaning — same class as the
classifier-swap route; M6's `M6-FILTER` class is untouched, not reused).

`GET /api/health` gains `job: JobSnapshot | null` — `null` when no
supervisor is wired, or when `snapshot().state === "idle"` (never
started). Non-idle states (`running`, `stalled`, `completed`, `exhausted`,
`stopped`) report the full snapshot verbatim, per Task 1's own framing of
`"idle"` as the `job: null` signal.

The 409-vs-500 split is a string match on `e.message === "reprocess job
already active"` (the one message `JobSupervisor.start()` throws for that
case) — brittle in the abstract, but it's the only error that string
means, and introducing a dedicated error class for one call site would be
over-engineering for this surface.

## Alert wiring

`AlertEvent` (`src/core/alerts/types.ts`) became a discriminated union so
`nlm.job.stalled` can carry its own payload shape
(`{job, reason, processed, total, restarts, lastAdvanceAt, message}`)
alongside the existing drift/embedder `{current, latest, since}` shape.
`buildJobAlertEvent` (`src/core/alerts/job-alert.ts`) is a pure 1:1
mapping — no debounce state needed, unlike `drift-transition.ts` /
`embedder-transition.ts`, because `JobSupervisor` already only emits
`"stalled"` once per stall episode and `"exhausted"` once per run.

Binding-note wording: the brief added a `message` field (not in the
brief's literal data-shape list, but additive) that spells out
`"reprocess gave up after N fruitless restarts (P/T processed)"` for
exhausted events specifically so `restarts: N` at exhaustion — which
always includes the refused final attempt — can't be misread by whoever
reads the alert as "N more restarts about to happen."

## CLI auth pattern used

`nlm reprocess --daemon` copies the exact pattern `nlm ui`'s
bootstrap-nonce POST already uses (`src/cli/nlm.ts`, the `ui` command):
`autoloadEnv()` (so a fresh shell without a sourced `.env` still picks up
`NLM_MCP_TOKEN`), read `process.env["NLM_MCP_TOKEN"]`, send it as
`Authorization: Bearer <token>` when present. No token present still
works — the daemon's local-mode auth gate (`installLocalOnlyMiddleware`)
falls back to `DEFAULT_TEAM_ID` when `NLM_UI_AUTH` is off (the default),
same as every other unauthenticated local caller.

The command's own flags (`--limit`, `--min-confidence`, `--only-null`,
`--exclude-model` (repeatable), `--state`, `--dry-run`, `--force-embed`)
are forwarded as argv strings in the POST body's `args` array.
`-v`/`--verbose` is never forwarded — the daemon's spawn adapter always
appends `-v` itself (`job-supervisor.ts`'s progress parser needs it), and
a local `--verbose` would only affect this short-lived CLI process's own
stdout, which the daemon-mode path never touches. Prints the 202/409 (or
other) outcome and exits 0 on 202, 1 on anything else, including an
unreachable daemon.

## Shutdown-reap answer

The daemon **does** have a SIGINT/SIGTERM shutdown hook, and
`jobSupervisor.stop()` is now called from it — but that hook is only
registered conditionally, inside `if (opts.scheduler !== false)` **and**
only when `adapters.length > 0` (`src/cli/nlm.ts`, end of the `start`
command). Running with `--no-scheduler`, or on a host where
`buildAdapters()` detects zero adapters, means **no shutdown hook
registers at all** — pre-existing behavior, unrelated to this task, and
out of scope to restructure per the brief's instruction not to invent a
new shutdown mechanism. In that configuration an active reprocess child
will not be reaped on daemon exit; it's an orphaned but not runaway
process (the child's own `reprocess` command exits normally once its work
loop finishes, same as running it in-process).

## Test evidence

```
$ npx tsc --noEmit
(clean, no output)

$ npx vitest run tests/unit/core/alerts/job-alert.test.ts
 Test Files  1 passed (1)
      Tests  5 passed (5)

$ npx vitest run tests/unit/core/jobs/job-alert-emission.test.ts
 Test Files  1 passed (1)
      Tests  2 passed (2)

$ npx vitest run tests/unit/http/jobs-routes.test.ts
 Test Files  1 passed (1)
      Tests  9 passed (9)

$ npx vitest run tests/integration/hosted-mode-gate.test.ts
 Test Files  1 passed (1)
      Tests  37 passed (37)

$ npx vitest run tests/integration/http.test.ts
 Test Files  1 passed (1)
      Tests  82 passed (82)

$ npm test -- --run 2>&1 | tail -8
 Test Files  27 failed | 268 passed | 1 skipped (296)
      Tests  7 failed | 2315 passed | 228 skipped (2550)
```

The 27 failed files are the exact same `*.pg.test.ts` (Postgres
connectivity) set documented in Task 1's report — `ECONNREFUSED
127.0.0.1:54329`, no live Postgres in this environment. Passing count
rose from 2292 (Task 1's fix-pass total) to 2315, i.e. +23, matching
exactly the new tests added here (5 + 2 + 9 + 4 hosted-gate + 3 health =
23). No regressions in any non-pg file, re-verified after the self-review
fix commit too.

## Commits

- `d357053` `feat(jobs): add nlm.job.stalled alert event + JobSupervisor mapping`
- `f4eecde` `test(jobs): unit tests for buildJobAlertEvent + fireAlert emission wiring`
- `10231ca` `feat(jobs): add POST/DELETE /api/jobs/reprocess + job block on /api/health`
- `585695f` `test(jobs): route tests for /api/jobs/reprocess + extend health/hosted-gate`
- `fb306e0` `feat(jobs): wire JobSupervisor into the daemon + nlm reprocess --daemon`
- `8fd13ba` `fix(jobs): use independent per-stream buffers in the real spawn adapter`

## Self-review findings (git diff 9886d23..HEAD)

One issue found and fixed before finishing (see `8fd13ba`): the real
`SpawnChild` adapter (`src/cli/reprocess-job-adapters.ts`) originally fed
both `child.stdout` and `child.stderr` `'data'` events through **one**
shared line buffer. Since stdout and stderr are independent streams that
can each deliver a partial (no-newline-yet) chunk in either order, a
shared buffer could splice an in-flight partial line from one fd together
with an unrelated chunk landing on the other fd first — corrupting the
`[i/n]` parse. Not reachable today (reprocess's `-v` output is
stderr-only, stdout is silent until the final JSON report after the work
loop ends), but a real latent bug that would bite the moment any stray
stdout write appears mid-run. Fixed with independent per-stream buffers,
both still feeding the same `onLine` callback.

## Concerns / open items for later

- The 409-vs-500 split in the route handler string-matches
  `"reprocess job already active"`. If `JobSupervisor.start()`'s throw
  message ever changes, this silently degrades to a 500 instead of a 409
  — no test would catch that without exercising a real `JobSupervisor`
  hitting the concurrent-start path through the HTTP layer (the route
  tests use a fake supervisor that throws whatever message the test
  wants). Low risk, single call site, flagging for completeness.
- Real spawn/clock adapters (`reprocess-job-adapters.ts`) have no direct
  unit tests, consistent with Task 1's stated design ("thin and
  unremarkable... no logic to test") and confirmed here: the
  fetchImpl/fake-spawner emission test exercises the identical port
  shapes, just not the real `child_process`/`Date.now()` implementations
  underneath. An integration test that actually spawns a tiny real child
  process was judged out of scope for this task's TDD instructions
  (which named routes + alert emission specifically).
- Shutdown-hook gap (`--no-scheduler` / zero-adapters daemons never reap
  the child) is pre-existing and documented above, not fixed here per the
  brief's explicit instruction not to invent a new shutdown mechanism.
