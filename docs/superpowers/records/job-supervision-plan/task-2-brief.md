## Task 2 — daemon wiring + HTTP + CLI

- Spawn adapter (`src/daemon/` or wherever `nlm start` composes — follow the existing composition root in `src/cli/nlm.ts`): real `child_process.spawn` of `process.execPath` + the daemon's own `dist/cli/nlm.js` path with the run args + `-v`, line-buffered stderr+stdout reader.
- Routes in `src/http/app.ts`: `POST /api/jobs/reprocess` (body: optional `{args: string[]}` limited to reprocess's own flag surface — pass through verbatim, the CLI validates), 202 on start, 409 if active; `DELETE /api/jobs/reprocess` → 200 stop. Both added to `HOSTED_GATED_ROUTES` as LOCAL. `GET /api/health`: add `job: supervisor.snapshot()`.
- `fireAlert` wiring: supervisor `onEvent` → new `nlm.job.stalled` AlertEvent (add to `src/core/alerts/types.ts`; data: `{job: "reprocess", reason, processed, total, restarts, lastAdvanceAt}`).
- CLI: `nlm reprocess --daemon` → POST to `http://127.0.0.1:<port>/api/jobs/reprocess` with the remaining flags, print the 202/409 result; follow the CLI's existing daemon-call auth pattern exactly.
- Tests: route tests (start/409/stop/health-block/hosted-403), alert-event emission test with fake webhook (existing fire-alert test pattern).

