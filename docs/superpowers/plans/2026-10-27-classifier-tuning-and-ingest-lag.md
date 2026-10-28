# Classifier tuning settings + ingest-lag visibility (T1177)

## Context

On 2026-10-27 capture was ~3.5 days behind. `litellm-classifier` moved to a gemma-4-12B
model on 10/23. That model reasons ~870 tokens even on a trivial prompt, so full transcripts
blow the scheduler's 120s per-call classify timeout, and the scheduler retries with backoff.
The only think-off control is `classifierNeedsThinkDisabled` in `src/llm/model-quirks.ts`:
a regex on the model *name* (`/qwen3\.5/`), Ollama-only. Behind an opaque gateway alias it
silently stopped applying, and nothing surfaced the growing backlog.

Measured against the live gateway: an OpenAI-compatible request with
`chat_template_kwargs: {"enable_thinking": false}` drops completion tokens 871 → 15 and
returns the answer in `content`. `reasoning_effort: "none"` and `think: false` do NOT work on
this lane.

Goal: thinking mode, classify timeout and max tokens are explicit, persisted settings that
can be read and changed from NLM's HTTP API and the Settings → Classifier UI page, and take
effect live without a restart. Ingest lag is measured, shown in the UI, and fires an alert,
so a stalled or slow classifier can't hide again.

## Global Constraints

- Repo `nlm-memory`; gate is `npm run typecheck && npm test`. TypeScript strict, vitest.
- Storage has two backends: SQLite (default, `migrations/NNN_*.sql`) and Postgres
  (`migrations/pg/`). Any new persisted state needs both, following the `providers`
  table's pattern (store port in `src/ports/`, sqlite + pg adapters). Next SQLite migration
  number is `037`.
- Settings are daemon-wide (not per-tenant): one classifier serves the daemon.
- Thinking mode values are exactly `"off" | "on"`. Default `"off"` (classification is JSON
  extraction; reasoning only costs time). `"off"` means:
  - provider `openai`: request body gets `chat_template_kwargs: { enable_thinking: false }`
  - provider `ollama`: request gets `think: false` (existing OllamaClient option)
  - provider `deepseek` (cloud API): nothing is sent (its API has no such switch)
  - `"on"` sends nothing for any provider (model default).
- Delete `src/llm/model-quirks.ts` and every use of `classifierNeedsThinkDisabled`; the
  explicit setting replaces it. No compat shim.
- Effective value precedence: persisted setting (written via API/UI) > env var > built-in
  default. Env vars: `NLM_CLASSIFIER_THINKING` (`off|on`), `NLM_CLASSIFIER_TIMEOUT_MS`
  (existing scheduler default 120000), `NLM_CLASSIFIER_MAX_TOKENS` (existing; default is
  the client's current default). Every API read reports each value's `source`:
  `"setting" | "env" | "default"`.
- Validation at the HTTP boundary only: `timeout_ms` integer 10000..900000; `max_tokens`
  integer 256..65536; `thinking` one of the two values. Reject anything else with 400.
- Live apply: a settings write updates the running `ClassifierBox` and the scheduler's
  per-call timeout on the next classify call. No restart.
- No `max_tokens` is sent unless the effective value comes from a setting or env (keep the
  client default otherwise).
- Alerts reuse the existing CloudEvents webhook path (`src/core/alerts/`, `fireAlert`,
  `NLM_ALERT_WEBHOOK`) and the transition/debounce pattern of `embedder-transition.ts`
  (fire once on entering the bad state, once on recovery; persist in alert-state.json).
- UI is React in `src/ui/`; follow the existing Settings page components and styles. No new
  UI dependencies.
- No secrets in logs or API responses.

## Task 1: Persisted classifier tuning settings, live apply, HTTP API

Files: `src/llm/classifier-box.ts`, `src/llm/build-classifier.ts`, `src/llm/deepseek-client.ts`,
`src/llm/ollama-client.ts` (only if needed), delete `src/llm/model-quirks.ts`,
`src/core/scheduler/scheduler.ts`, new store port + sqlite/pg adapters, migrations
`037_classifier_settings.sql` + pg twin, `src/http/app.ts` (`registerClassifierRoutes`),
daemon wiring in `src/cli/` where the scheduler and box are built, tests.

1. Settings store: a single-row (or key/value) table holding nullable `thinking`,
   `timeout_ms`, `max_tokens`, `updated_at`. Store port with `get()` and `update(partial)`;
   `null` in an update clears that setting (falls back to env/default).
2. Resolver: a pure function `resolveClassifierTuning(stored, env)` returning
   `{ thinking, timeoutMs, maxTokens }`, each `{ value, source }` per the precedence rule.
   Unit-test every precedence branch and invalid env values (invalid env → ignored, default
   used, one warning logged at boot).
3. `ClassifierBox` takes the tuning and applies thinking/maxTokens when constructing the
   inner client; add `retune(tuning)` that rebuilds the inner client in place (same pattern
   as `swap`). `DeepSeekClient` gains an optional extra-body field it spreads into the chat
   request so the openai provider can send `chat_template_kwargs`. The box exposes the
   current `timeoutMs`; the scheduler reads the timeout from the box on each classify call
   instead of the fixed `opts.classifyTimeoutMs`.
4. HTTP:
   - `GET /api/classifier/info` adds `tuning: { thinking, timeout_ms, max_tokens }`, each
     `{ value, source }`; fix `available_providers` to include `"openai"` when that is the
     active provider.
   - `PUT /api/classifier/settings` body `{ thinking?, timeout_ms?, max_tokens? }` (value or
     `null`), validates, persists, re-resolves, retunes the live box, returns the new
     `tuning`. Register it with the same `LOCAL` disposition as `POST /api/classifier`.
5. Tests: resolver unit tests; box test that `off` + openai puts `chat_template_kwargs` in
   the request body (fake fetch) and `on` does not; ollama `off` sets `think:false`;
   deepseek sends neither; scheduler uses the box's current timeout after a retune; HTTP
   tests for GET shape, PUT persist + live apply, PUT 400 cases, `null` clearing.

## Task 2: Ingest-lag health metric, API and alert

Files: new `src/core/health/ingest-lag.ts`, `src/core/scheduler/scheduler.ts` (record
outcomes), `src/core/alerts/` (new transition + event type), `src/http/app.ts`, daemon
wiring, tests.

1. The scheduler records classify outcomes in memory: last successful classify time,
   last failure time and reason, counts of timeouts and errors in a rolling 60-minute
   window.
2. `computeIngestLag(...)` returns, per adapter (runtime): `pending` (source files the
   adapter discovers that are unseen in `adapter_state` or have `last_offset < file size`,
   excluding files parked at the failure ceiling, which are reported separately as
   `parked`), `oldest_pending_at` (mtime of the oldest pending file), and overall
   `last_success_at`, `timeouts_1h`, `errors_1h`, `lagging: boolean`. Reuse the adapters'
   existing discovery (`scan-once.ts` / adapter `discover`) rather than re-globbing paths.
   It must be cheap: a stat-only pass, no transcript reads, cached for 60s.
3. `lagging` is true when the oldest pending file is older than the threshold
   (`NLM_INGEST_LAG_ALERT_HOURS`, default 6), or pending > 0 and no successful classify in
   the last 60 minutes.
4. `GET /api/health/ingest` returns that object. Event type `nlm.health.ingest_lagging`
   fires through the debounced transition (enter / recover), checked on the same cadence
   as the existing embedder check; payload `current` = summary like
   `"412 pending, oldest 3d, 0 ok/1h"`, `latest` = `"caught up"`, `since`.
5. Tests: lag computation on fixture adapter_state + temp files (pending, behind, parked,
   oldest); `lagging` threshold boundaries; transition fires once on entry and once on
   recovery; HTTP shape.

## Task 3: UI — classifier tuning controls and ingest health

Files: `src/ui/pages/settings/Classifier.tsx`, `src/ui/lib/` (fetch helpers), the Pulse page
or app shell for a banner, UI tests if the repo has a UI test pattern (follow it).

1. Settings → Classifier gets a "Tuning" section: Thinking (off/on select), Timeout
   (seconds input, converted to ms), Max tokens (number input, blank = use env/default).
   Each control shows its effective value and source badge (`setting` / `env` /
   `default`), plus a "reset to default" that sends `null`. Save calls
   `PUT /api/classifier/settings` and shows the returned tuning.
2. An "Ingest health" panel on the same page, from `GET /api/health/ingest`: per-runtime
   pending / parked / oldest pending age, last successful classify, timeouts and errors in
   the last hour. Refresh every 30s while the page is open.
3. When `lagging` is true, show a warning banner in the app shell (visible on every page)
   linking to Settings → Classifier, with the one-line summary.
4. Build the UI (`npm run build:ui`) clean; no new dependencies.

## Verification (after landing)

- Gate: `npm run typecheck && npm test` green in the worktree; `nxtgit land`.
- Deploy the new version through the normal nxtos NLM install, restart
  `io.whtnxt.nxtos.nlm`, then: `GET /api/classifier/info` shows `thinking: off (default)`;
  `daemon.err` stops showing 120s timeouts; `sessions` rows created per hour rises well
  above the pre-fix ~3/hour; `GET /api/health/ingest` pending counts fall over the next
  hours; the UI page shows tuning + health; toggle thinking from the UI and confirm the
  next classify request reflects it.
