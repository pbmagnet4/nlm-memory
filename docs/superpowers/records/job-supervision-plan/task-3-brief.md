## Task 3 — digest section + docs

- Daily digest (`src/core/digest/compose.ts`): one `Jobs:` line — active run (`reprocess 412/664, last advance 3m ago`) or last completed outcome if the supervisor holds one (keep last-run summary in supervisor state; no persistence across daemon restarts — a daemon restart mid-run is the operator's action, note it in the line as "no active job"). Test in the digest compose suite.
- Docs: README env table rows (`NLM_JOB_STALL_MINUTES`), `docs/hooks.md`-adjacent or wherever /api/health is documented — follow where the existing health fields are described; CHANGELOG entry is the controller's job, not yours.

## Acceptance (#414)

A reprocess started via the daemon that dies or stalls produces a Matrix #ops-alerts message within ~stall-window minutes and is visible in `/api/health` the whole time; a healthy run restarts transparently after an OOM; nothing new runs on cron; `nlm reprocess` inline behavior unchanged.
