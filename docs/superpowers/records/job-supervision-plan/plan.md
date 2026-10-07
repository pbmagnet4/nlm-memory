# Daemon job supervision (plan)

Board: Whtnxt Agent NocoDB #414 (P1, due 2026-08-03). Trigger: the Gemma reprocess died on a V8 OOM and sat dead ~16h unobserved — twice now (07-27 and the 07-27→08-03 gap). Design pinned in the task notes: supervision lives IN the daemon, not a bolt-on watchdog; report through existing surfaces (health, alerts, daily digest); no new cron.

## Design (controller decisions)

- **One job type: reprocess.** No generic job framework (YAGNI). The supervisor is a small daemon-side component that owns at most ONE child reprocess run at a time.
- **Child process, not in-process:** spawn `process.execPath dist/cli/nlm.js reprocess <args>` — reprocess has a long-run memory leak; a child OOM must not take the daemon down. Reprocess is already checkpoint-resumable, so restart = re-spawn same args.
- **Progress signal:** parse the child's existing stderr/stdout `[N/total] <id> ok` verbose lines (spawn with `-v`). Every advance updates `lastAdvanceAt` + `processed/total`.
- **Restart policy:** on child exit with work remaining → re-spawn, max 3 restarts *without progress* (a restart after new progress resets the counter). Cap exhausted or stalled → alert.
- **Stall definition:** child alive but no advance for `NLM_JOB_STALL_MINUTES` (default 20) → fire `nlm.job.stalled` once per stall episode (not per check). Also fired when the cap is exhausted with work remaining (data.reason distinguishes "stalled" vs "exhausted").
- **Surfaces:** `GET /api/health` gains a `job` block (`null` when idle; else `{name, state, processed, total, startedAt, lastAdvanceAt, restarts}`); daily digest gains a one-line jobs section (running/idle/last outcome); `POST /api/jobs/reprocess` starts a run (409 if one is active), `DELETE /api/jobs/reprocess` stops it. Both routes are LOCAL-dispositioned in `HOSTED_GATED_ROUTES` (whole-DB operator surface, hosted-403).
- **CLI:** `nlm reprocess --daemon` POSTs to the local daemon instead of running inline (auth: same operator token the CLI already uses for daemon calls; find the existing pattern). Inline `nlm reprocess` stays unchanged for manual runs.
- **Alert destination is already live:** `NLM_ALERT_WEBHOOK` set 2026-08-03 → n8n `/webhook/nlm-alert` → Matrix #ops-alerts. `fireAlert` + `AlertEvent` exist in `src/core/alerts/`; add the third event type there.

## Global constraints

- Pure-core supervisor logic with injected ports (clock, spawner) — testable without real processes, matching the codebase's hexagonal convention. Side-effectful spawn adapter thin and unremarkable.
- Never crash the daemon: every supervisor path swallows/reports, same posture as telemetry.
- No new dependencies, no new cron surfaces, no watchdog scripts.
- TDD per task; `tsc --noEmit` + suite green per task (7 pre-existing pg-connectivity failures excepted).
- Local mode is the ONLY mode for this feature in beta (hosted gets 403 via LOCAL disposition).

## Task 1 — core JobSupervisor

`src/core/jobs/job-supervisor.ts`: class or closure managing one run. API: `start(args: string[])` (throws/refuses if active), `stop()`, `snapshot()` → the health `job` block shape, plus an `onEvent` callback port for alert firing (`{kind: "stalled" | "exhausted", ...}`). Injected ports: `spawnChild(args) → {onLine(cb), onExit(cb), kill()}`, clock. Restart policy + stall timer per the design above (stall check on a coarse `setInterval` behind the clock port). Parse progress lines with the exact `[N/total]` regex from reprocess's verbose output — verify the real format in `src/core/ingest/reprocess.ts` first and note it in the report. Unit tests (fake spawner + fake clock): normal completion; exit-with-work-remaining restarts; 3 no-progress restarts → exhausted event, no 4th spawn; progress resets the counter; stall event fires once per episode; stop() kills and goes idle; snapshot shapes for idle/running/stalled.

## Task 2 — daemon wiring + HTTP + CLI

- Spawn adapter (`src/daemon/` or wherever `nlm start` composes — follow the existing composition root in `src/cli/nlm.ts`): real `child_process.spawn` of `process.execPath` + the daemon's own `dist/cli/nlm.js` path with the run args + `-v`, line-buffered stderr+stdout reader.
- Routes in `src/http/app.ts`: `POST /api/jobs/reprocess` (body: optional `{args: string[]}` limited to reprocess's own flag surface — pass through verbatim, the CLI validates), 202 on start, 409 if active; `DELETE /api/jobs/reprocess` → 200 stop. Both added to `HOSTED_GATED_ROUTES` as LOCAL. `GET /api/health`: add `job: supervisor.snapshot()`.
- `fireAlert` wiring: supervisor `onEvent` → new `nlm.job.stalled` AlertEvent (add to `src/core/alerts/types.ts`; data: `{job: "reprocess", reason, processed, total, restarts, lastAdvanceAt}`).
- CLI: `nlm reprocess --daemon` → POST to `http://127.0.0.1:<port>/api/jobs/reprocess` with the remaining flags, print the 202/409 result; follow the CLI's existing daemon-call auth pattern exactly.
- Tests: route tests (start/409/stop/health-block/hosted-403), alert-event emission test with fake webhook (existing fire-alert test pattern).

## Task 3 — digest section + docs

- Daily digest (`src/core/digest/compose.ts`): one `Jobs:` line — active run (`reprocess 412/664, last advance 3m ago`) or last completed outcome if the supervisor holds one (keep last-run summary in supervisor state; no persistence across daemon restarts — a daemon restart mid-run is the operator's action, note it in the line as "no active job"). Test in the digest compose suite.
- Docs: README env table rows (`NLM_JOB_STALL_MINUTES`), `docs/hooks.md`-adjacent or wherever /api/health is documented — follow where the existing health fields are described; CHANGELOG entry is the controller's job, not yours.

## Acceptance (#414)

A reprocess started via the daemon that dies or stalls produces a Matrix #ops-alerts message within ~stall-window minutes and is visible in `/api/health` the whole time; a healthy run restarts transparently after an OOM; nothing new runs on cron; `nlm reprocess` inline behavior unchanged.
