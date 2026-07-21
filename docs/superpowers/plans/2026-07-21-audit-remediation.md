# NLM Audit Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every actionable finding from the 2026-07-21 full audit (code, repo, npm, runtime, telemetry) and add a publish↔deploy drift guard so the running daemon can never silently fall behind releases again.

**Architecture:** Four waves. Wave 0 recovers the live runtime (redeploy stale daemon, verify embedder, smoke instrumentation) — everything else is downstream of a healthy runtime. Wave 1 is mechanical code fixes (SDD junior lane). Wave 2 repairs outcome instrumentation (the "does NLM improve results" question is unanswerable until this lands). Wave 3 builds the drift guard. Deferred items are listed, not tasked.

**Tech Stack:** TypeScript (strict, `exactOptionalPropertyTypes`), better-sqlite3, Postgres (pgvector, contract-tested via `NLM_PG_TEST_URL`), vitest, launchd, NxtOS-managed install at `~/Library/Application Support/NxtOS/nlm/`.

## Global Constraints

- `npm run typecheck` (BOTH tsconfigs) + `npx vitest run` green before every commit. Never `tsc -p tsconfig.json` alone.
- Any SQLite schema change must be mirrored in `migrations/pg/` as a NEW numbered file (the version-gated pg runner auto-applies; do NOT edit `pg/001_initial.sql` for new changes).
- Postgres-touching tasks run the pg contract suite against a live container: `docker run -d --name nlm-pg-test -e POSTGRES_PASSWORD=test -p 54329:5432 pgvector/pgvector:pg16` then `NLM_PG_TEST_URL=postgres://postgres:test@localhost:54329/postgres npx vitest run tests/**/*.pg.test.ts`. Tear down after (`docker rm -f nlm-pg-test`).
- Scripts touching live operator data get a live smoke run before being trusted (standing learnings rule).
- Release discipline: never `npm publish` by hand; version bumps touch BOTH `package.json` and `plugin/.codex-plugin/plugin.json`.
- NocoDB writes: read the per-base schema file in the orchestrator workspace (`.claude/nocodb/`) before first write; NLM base/Tasks-table IDs live in the orchestrator CLAUDE.md, not here; agent-created tasks get `Auto-Created: true`.
- Repo publish policy: nlm-memory is PUBLIC — no home paths, client names, or internal hostnames in committed files.

---

## Wave 0 — Runtime recovery (execute inline, NOT subagents: touches live service + operator env)

### Task 1: Redeploy daemon to current release

**Files:** none in repo (ops task against `~/Library/Application Support/NxtOS/nlm/`)

**Interfaces:**
- Produces: daemon at `localhost:3940` reporting `version: 0.20.1` — Tasks 2, 3, 11, 12 depend on this.

- [ ] **Step 1: Inspect the existing deploy layout to mirror it exactly**

```bash
cat ~/Library/Application\ Support/NxtOS/nlm/current/run.sh
ls ~/Library/Application\ Support/NxtOS/nlm/versions/0.20.0/
```
Expected: run.sh reveals node invocation + env; version dir reveals whether it's an npm-installed package or a copied dist. Record both.

- [ ] **Step 2: Check whether NxtOS owns an upgrade command before doing it by hand**

```bash
grep -rn "versions\|current\|nlm" ~/Documents/Coding\ Projects/nxtos/src --include="*.ts" -l 2>/dev/null | head -5
```
If an NxtOS install/upgrade module exists, use it (read its usage; likely `nxtos install nlm@0.20.1` shape). If not, proceed manually:

```bash
cd ~/Library/Application\ Support/NxtOS/nlm/versions
mkdir 0.20.1 && cd 0.20.1
npm init -y >/dev/null && npm install nlm-memory@0.20.1
# mirror run.sh from 0.20.0, adjusting paths; copy any .env/config the old dir carried
cp ../0.20.0/run.sh . 2>/dev/null && sed -i '' 's/0\.20\.0/0.20.1/g' run.sh
```

- [ ] **Step 3: Flip symlink + restart (get Edward's go-ahead first — live service)**

```bash
ln -sfn ~/Library/Application\ Support/NxtOS/nlm/versions/0.20.1 ~/Library/Application\ Support/NxtOS/nlm/current
launchctl kickstart -k gui/$(id -u)/io.whtnxt.nxtos.nlm
sleep 5 && curl -s localhost:3940/api/health | python3 -m json.tool
```
Expected: `"version": "0.20.1"`, `"status": "ok"`. If health fails: revert symlink to `versions/0.20.0`, kickstart again, and stop — file findings instead.

### Task 2: Embedder warmup verification

**Files:** none (config/env)

- [ ] **Step 1: Identify the configured embedder endpoint**

```bash
grep -iE "embed|OLLAMA|OPENAI|LM_?STUDIO|BASE_URL" ~/Library/Application\ Support/NxtOS/nlm/current/run.sh ~/Library/Application\ Support/NxtOS/nlm/current/.env 2>/dev/null
```

- [ ] **Step 2: Verify the endpoint answers; if it's the manually-served LM Studio lane and it's down, surface to Edward rather than auto-starting (standing rule: Edward starts LM Studio manually)**

```bash
curl -s --max-time 3 <base-url-from-step-1>/models | head -c 300
```

- [ ] **Step 3: Confirm warmup**

```bash
curl -s localhost:3940/api/health | python3 -c "import sys,json; h=json.load(sys.stdin); print(h['warmup'], h['embedding'])"
```
Expected: `textEmbedder: true, ready: true`, embedding lanes not `unknown`. Semantic-mode recall smoke: `curl -s "localhost:3940/api/recall?q=recall%20service&mode=semantic" | head -c 200` returns hits, not an error.

### Task 3: Instrumentation smoke — is citation capture alive on 0.20.1?

**Files:** none (observation)

**Interfaces:** Produces: verdict `capture-works` | `capture-dead` — routes Task 12.

- [ ] **Step 1: Baseline count, then exercise one real recall+stop cycle** (open a throwaway Claude Code session in any repo, ask a question that triggers recall, let the session stop)

```bash
BEFORE=$(grep -c '"kind":"stop"' ~/.nlm/hook-log.jsonl)
# ...run the throwaway session...
tail -5 ~/.nlm/hook-log.jsonl | python3 -c "import sys,json; [print(json.loads(l).get('kind'), json.loads(l).get('citedIds')) for l in sys.stdin]"
```
Expected if healthy: a new `stop` event; `citedIds` non-null at least when the response used a recalled session. Record verdict for Task 12.

### Task 4: Resume corpus reprocess (existing NocoDB #390, P1)

- [ ] **Step 1:** Read full notes of NocoDB task #390 (`nocodb_get_record`, NLM Tasks table, id 390) for the exact relaunch command and resume-cursor semantics. Relaunch per those notes against the now-current daemon. Update #390 status to In Progress; Done when the run completes past 5,304 sessions.

---

## Wave 1 — Mechanical fixes (SDD dispatch, one subagent per task, haiku/sonnet lane)

### Task 5: Widen Postgres `session_edges.kind` CHECK to match SQLite

**Files:**
- Create: `migrations/pg/031_widen_session_edges_kind.sql`
- Test: `tests/integration/session-edges-parity.pg.test.ts` (new)

**Interfaces:** Produces: pg accepts all five `SessionEdgeKind` values SQLite accepts.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/integration/session-edges-parity.pg.test.ts
import { describe, it, expect } from "vitest";
import { newPgTestStorage } from "./helpers/pg"; // match the import used by existing *.pg.test.ts files — check tests/integration/ for the exact helper name and mirror it

const PG_URL = process.env["NLM_PG_TEST_URL"];

describe.skipIf(!PG_URL)("session_edges.kind parity", () => {
  it("accepts all five edge kinds that SQLite accepts", async () => {
    const storage = await newPgTestStorage();
    const kinds = ["supersedes", "replaces", "continues", "branched_from", "merged_from"];
    for (const kind of kinds) {
      // insert two minimal sessions then an edge of this kind; expect no throw
      await expect(insertEdgePair(storage, kind)).resolves.not.toThrow();
    }
  });
});
```
(Adapt `newPgTestStorage`/`insertEdgePair` to the repo's existing pg test helper conventions — copy the setup block from any existing `*.pg.test.ts`, do not invent a new harness.)

- [ ] **Step 2: Run against live pg container — expect FAIL** on `branched_from` with CHECK violation.

- [ ] **Step 3: Write the migration**

```sql
-- migrations/pg/031_widen_session_edges_kind.sql
-- Parity: SQLite migrations/019 allows five kinds; pg/019 narrowed to three.
ALTER TABLE session_edges DROP CONSTRAINT IF EXISTS session_edges_kind_check;
ALTER TABLE session_edges ADD CONSTRAINT session_edges_kind_check
  CHECK (kind IN ('supersedes','replaces','continues','branched_from','merged_from'));
```
Note: confirm the actual constraint name first (`SELECT conname FROM pg_constraint WHERE conrelid='session_edges'::regclass AND contype='c'` in the test container) — if it's an inline unnamed CHECK, the generated name differs; use the discovered name.

- [ ] **Step 4: Run test — expect PASS.** Full suite + typecheck. **Step 5: Commit** `fix(pg): widen session_edges.kind CHECK to five-kind parity with SQLite`

### Task 6: Delete dead `SessionStore.list()` (the 99MB-body bug class)

**Files:**
- Modify: `src/ports/session-store.ts:40` (remove method), `src/core/storage/sqlite-session-store.ts:608-617`, `src/core/storage/pg-session-store.ts` (its `list` impl), any tests referencing `.list(`

- [ ] **Step 1: Prove zero production callers**

```bash
grep -rn "\.list(" src/ --include="*.ts" | grep -v test | grep -vE "listByDateRange|listAll|listWorkstreams|list_records"
```
Expected: only the two store implementations + port declaration. If ANY other caller appears, STOP and report instead of deleting.

- [ ] **Step 2: Delete method from port + both stores; delete/adjust unit tests that tested it. Step 3:** typecheck + full suite green. **Step 4: Commit** `refactor: remove unused SessionStore.list() — O(corpus) body-column select, incident-class method with zero callers`

### Task 7: Single source of truth for the daemon port

**Files:**
- Create: `src/shared/net.ts`
- Modify: `src/cli/nlm.ts:133`, `src/hook/recall-over-http.ts:52`, `src/hook/session-start-hook.ts:100`, `src/hook/pre-compact-hook.ts:36`, `src/hook/subagent-start-hook.ts:40`, `src/hook/stop-hook.ts:175`, `src/http/app.ts:350`, `src/ui/vite.config.ts:15`, `src/ui/App.tsx:59`

- [ ] **Step 1:**

```typescript
// src/shared/net.ts
/** Single source of truth for the daemon's default port. A hook and the
 *  daemon disagreeing on this default silently splits the system. */
export const DEFAULT_NLM_PORT = "3940";
```

- [ ] **Step 2:** Replace each literal `"3940"` fallback with the import (UI files: if `src/ui` can't import from `src/shared` due to build boundaries, check vite config aliasing first; if truly separate, leave the two UI occurrences with a `// keep in sync with src/shared/net.ts DEFAULT_NLM_PORT` comment instead — do not force a cross-bundle import).
- [ ] **Step 3:** `grep -rn '"3940"' src/ | grep -v net.ts` → only permitted UI remnants (if any) with sync comments. Typecheck + tests. **Commit** `refactor: DEFAULT_NLM_PORT single source of truth`

### Task 8: Label the unlabeled silent catches

**Files:** `src/core/recall-facts/fact-recall-service.ts:213`, `src/core/dataset/build-dataset.ts:577`, `src/core/ingest/reprocess.ts:126`, `src/core/exemplars/extract-exemplar.ts:54,85,125`, `src/core/scheduler/scan-once.ts:68,174`, `src/core/scheduler/scheduler.ts:58`, `src/core/storage/supersedence-log.ts:39,59`

- [ ] **Step 1:** Add a one-line "why + what degrades" comment to each bare `catch`, matching the style of the 120+ already-labeled ones. `fact-recall-service.ts:213` specifically: `// Best-effort: corroboration boost skipped on any FactStore failure — recall proceeds unboosted. If boosts seem globally absent, look here first.`
- [ ] **Step 2:** typecheck (comment-only change). **Commit** `docs(core): label remaining silent catch blocks with degradation notes`

### Task 9: npm vulnerabilities — fixable pair

- [ ] **Step 1:** `npm audit fix` (targets body-parser + protobufjs per audit; NOT `--force`). **Step 2:** `git diff package-lock.json | head -50` — verify only those two dep trees moved. **Step 3:** typecheck + full suite. **Step 4: Commit** `chore(deps): npm audit fix — body-parser DoS, protobufjs infinite-loop CVEs`. adm-zip (transitive via @huggingface/transformers, fix requires breaking bump) → Deferred list, tracked in NocoDB (Task 16).

### Task 10: Git sync + idempotent release step

**Files:** `.github/workflows/release.yml`

- [ ] **Step 1:** `git pull --rebase origin main && git push origin main` (resolves 1-ahead/3-behind). If rebase conflicts: stop, report.
- [ ] **Step 2:** In release.yml, guard the `gh release create` step:

```yaml
- name: Create GitHub Release
  run: |
    if gh release view "${GITHUB_REF_NAME}" >/dev/null 2>&1; then
      echo "release ${GITHUB_REF_NAME} already exists — skipping (idempotent re-run)"
    else
      gh release create "${GITHUB_REF_NAME}" --generate-notes
    fi
```
(Adapt flag details to the existing step's current arguments — preserve any notes/asset flags it already passes.)

- [ ] **Step 3: Commit** `ci: make GitHub Release creation idempotent (fixes 422 on re-run)`

---

## Wave 2 — Instrumentation truth (sequenced after Wave 0; #352 needs Edward's sign-off first)

### Task 11: Finish NocoDB #352 (outcome/persona columns + subagent linkage)

- [ ] **Step 1:** Read #352's design doc (path in its Notes: `Whtnxt Agent/docs/superpowers/specs/…` — pull full record via `nocodb_get_record`). Present the design to Edward for sign-off — it is explicitly awaiting this.
- [ ] **Step 2 (post-sign-off):** Execute per that spec (it is its own plan; do not duplicate here). Acceptance add-on from this audit: `subagent-log.jsonl` `parent_conversation_id` must be non-"unknown" for new rows — verify with a live subagent dispatch after implementation.

### Task 12: Citation capture — conditional on Task 3 verdict

- [ ] **If `capture-works`:** close this task; the 0% July rate was the stale-deploy skew. Note the finding in the wiki learnings entry for the audit.
- [ ] **If `capture-dead`:** trace the pipeline: `src/hook/stop-hook.ts` (reads transcript, extracts cited session ids) → hook-log `kind:stop` writer. Reproduce with a fixture transcript containing a known `sess_`/`cc_` id in a tool_use block; assert extraction returns it. Bisect: does the deployed hook binary differ from repo HEAD (`diff <(cat ~/.claude/settings.json | grep -o 'nlm[^"]*hook[^"]*') <repo hook install paths>`)? Fix at root cause; add the fixture as a regression test named after the bug. Commit `fix(hook): restore citedIds extraction on stop events`.

### Task 13: Run overdue #393 usefulness re-measure (after 7-day post-redeploy soak)

- [ ] **Step 1:** No earlier than 7 days after Task 1 completes: `npx tsx scripts/eval/pull-usefulness.ts` (exact invocation per #393 notes). **Step 2:** Compare against the #392-ship baseline in the task; update #393 with results + Done. If deliberate-recall/session is still <0.5 after a healthy week, file a new P1 task: "pull-first recall regression — deliberate usage collapsed" with the W29 data attached.

---

## Wave 3 — Publish↔deploy drift guard (the "stay in sync" mechanism)

**Design decision (recommended, matches Edward's manual-serve preference):** alert on drift, never auto-upgrade. Detection is nearly free because `src/core/update-check/` already polls npm with a 24h cache; the gap is (a) health doesn't expose it, (b) nothing watches health for drift.

### Task 14: Expose update status in `/api/health`

**Files:**
- Modify: `src/http/app.ts` (health handler), `src/core/update-check/` (export cached-read accessor if not already exported)
- Test: extend existing health endpoint test file

- [ ] **Step 1: Failing test** — health response includes `update: { current: string, latest: string | null, behind: boolean }` (mock the update-check cache read; do not hit the network in tests).
- [ ] **Step 2:** Wire the cached `UpdateStatus` (module already returns `disabled`/`unknown` shapes on failure — map those to `latest: null, behind: false`; health must never fail because npm is unreachable).
- [ ] **Step 3:** Suite green. **Commit** `feat(health): expose update-check status (current vs npm latest)`

### Task 15: Drift-watch cron (Whtnxt Agent workspace, NOT this repo)

- [ ] **Step 1:** Via `/cron-manage` in the orchestrator workspace (five-surface contract: Hermes/crontab/NocoDB/Cronic/SwiftTab): daily job that runs:

```bash
H=$(curl -s --max-time 5 localhost:3940/api/health)
BEHIND=$(echo "$H" | python3 -c "import sys,json; h=json.load(sys.stdin); u=h.get('update',{}); print('yes' if u.get('behind') else 'no')")
READY=$(echo "$H" | python3 -c "import sys,json; print(json.load(sys.stdin).get('warmup',{}).get('ready'))")
# alert Matrix #ops-alerts (scripts/lib/notify.sh) when BEHIND=yes for >48h (state file) or READY != True
```
Full script lives in Whtnxt Agent `scripts/` (cross-cutting infra → orchestrator repo per code-quality rule 6). Alert copy: "NLM daemon vX behind npm latest Y for Nd — run the upgrade task" / "NLM embedder not ready since <ts>".
- [ ] **Step 2:** Also alerts when `warmup.ready` is false for two consecutive runs — catches the silent semantic-leg outage class from this audit.

---

## NocoDB bookkeeping (execute with Wave 1; read `.claude/nocodb/nlm*.md` schema file first)

- [ ] Create Auto-Created tasks: `pg session_edges CHECK parity (P2)` [close on Task 5], `Delete SessionStore.list() (P2)` [Task 6], `DEFAULT_NLM_PORT dedup (P3)` [Task 7], `adm-zip transitive CVE — needs transformers major bump (P3, deferred)`, `Drift-guard cron + health update field (P2)` [Tasks 14-15], `Dep majors staged bump: better-sqlite3 13 / react-router 7 / TS 7 (P3, deferred)`.
- [ ] Status sync: #390 → In Progress at Task 4; #393 → In Progress at Task 13; #352 remains In Progress, note "audit 2026-07-21 confirms this is the blocking gap for outcome measurement".

## Deferred (listed deliberately, no tasks — revisit after Wave 2 data)

- `RecallService.search()` split (P3 god-method; well-tested, defer until next functional change touches it)
- Dep majors: better-sqlite3 13, react-router-dom 7, typescript 7 — each is its own gated bump, batch after vulns settle
- adm-zip via @huggingface/transformers major bump
- #398 libSQL/Turso single-engine evaluation — if adopted, retires the entire pg-parity maintenance class (Tasks 5's bug class disappears); do the cheap Task 5 fix regardless
- Gemini/Codex adapters (#110) — market-breadth, not health

## Success criteria (the audit re-run, ~2 weeks out)

1. `/api/health`: `version` == npm latest, `warmup.ready: true`, `update.behind: false`.
2. citedIds capture rate > 0% over a real week of stop events.
3. #393 re-measure filed with a post-redeploy deliberate-recall/session number.
4. `npm audit --omit=dev`: no fixable highs. 5. pg contract suite green including the five-kind edge test.
