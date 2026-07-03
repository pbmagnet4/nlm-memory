# Corpus Retention Stage A+B (#353) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Execute in a FRESH session. Read the design first: `docs/superpowers/specs/2026-07-03-corpus-retention-design.md` (it holds the measured corpus numbers this plan is built on).

**Goal:** Ship the non-destructive retention layers: corpus-size monitoring with thresholds, a scheduled re-derivation baseline (the future compaction gate), exemplar prune wiring, and canonical entity consolidation (a real merge primitive plus a conservative dedup pass) that finally makes entity hygiene affect recall. Stage C (body compaction) is explicitly OUT of this plan; it unparks only on the three-part gate in the design doc.

**Architecture:** A `corpus-stats` core module (pure compute over a storage handle) feeds a 24h daemon timer (pattern: the integrity-check job) that appends JSONL and updates a module-level snapshot consumed by `/api/health` and `nlm health`. The same timer appends a weekly `nlm metric re-derivation` datapoint to a trend file. Entity merge lands as a storage-port method with sqlite and pg parity, rewiring `session_entities`, recomputing counts exactly, writing `entity_variants` (alias memory), and retiring the source row in place. A pure lexical suggestion scorer drives a `nlm entities dedup` CLI with dry-run default, safe-class auto-apply, and operator adjudication for the rest.

## Global Constraints

- This repo is PUBLIC. No internal hostnames, LAN IPs, home paths, client or unreleased-venture names in committed text (localhost/127.0.0.1 fine).
- No em dashes in ANY added text. No literal NUL bytes. No new dependencies. No narration comments (WHY-comments only).
- Full gate after every task: `npm run typecheck` clean + `npm test` green. Storage-touching tasks (4, 5) also run `npm run test:pg` with `NLM_PG_TEST_URL` set.
- Never commit anything under `.superpowers/`. Tests use temp dirs; NEVER touch `~/.nlm/` (no reads of canonical.sqlite in tests, no env-file access).
- Out of fence: `src/core/classifier/prompt.ts`, `src/llm/naming.ts`, `src/core/workstream/**`, daemon restart, any corpus-scale write against the live `~/.nlm/canonical.sqlite`. Applying the dedup to the LIVE corpus is an operator runbook step AFTER merge and daemon redeploy, not part of this plan's execution.
- Strict sqlite/pg parity for the merge primitive: both adapters in the same task, contract tests shared.
- If a task changes anything under `src/`, run `npm run build` and commit refreshed tracked plugin bundles in the same commit.
- Work in a worktree under `.worktrees/` on branch `feat/retention-stage-ab`; `git pull --rebase origin main` before merging.
- Commit style: `feat(retention): ...` / `feat(entities): ...`, one commit per task.

---

### Task 1: corpus-stats core + thresholds

**Files:** Create `src/core/metrics/corpus-stats.ts`, test beside the other metrics tests.

- [ ] Pure `computeCorpusStats(deps)` returning `{ dbBytes, sessions, bodyBytes, cappedBodies, entities, hapaxEntities, factsActive, factsSuperseded, factsRetired, markers, exemplars }`; deps is a minimal query interface implemented inline for sqlite (mirror `sqliteReDerivationDeps` in `src/core/metrics/re-derivation.ts:70-100`). dbBytes from `fs.statSync` on the db path.
- [ ] `parseCorpusThresholds(env)`: `NLM_CORPUS_WARN_BYTES` default 1_000_000_000, `NLM_CORPUS_ALERT_BYTES` default 2_000_000_000, non-numeric falls back to defaults (mirror `parseScoreFloor`'s defensive shape).
- [ ] `thresholdState(dbBytes, thresholds)`: `"ok" | "warn" | "alert"`.
- [ ] TDD with an in-memory sqlite fixture. Commit: `feat(retention): corpus stats core with size thresholds`

### Task 2: daemon wiring (24h stats job + weekly re-derivation trend + health surface)

**Files:** Modify `src/cli/nlm.ts` (new timer beside the integrity-check job at `scheduler.ts:73-94` pattern and the signal-prune timer at `nlm.ts:527-532`), `src/core/health/` (module-level snapshot, mirror `warmup-state.ts`), the `/api/health` handler, and the `nlm health` CLI output. Tests beside existing health tests.

- [ ] 24h `.unref()` timer: compute stats, append one JSON line to `~/.nlm/corpus-stats.jsonl` (path from the data dir helper the daemon already uses), update the snapshot, log a stderr warning when state is warn/alert.
- [ ] Same job: if the last line of `~/.nlm/re-derivation-trend.jsonl` is older than 7 days (or file absent), run `computeReDerivationRate(deps, 42)` and append `{ts, windowDays, rate, pairs, eligible}`.
- [ ] `/api/health` gains `corpus: { state, dbBytes, sessions, entities, lastComputedAt }` from the snapshot (null before first run); `nlm health` prints it.
- [ ] Fail-open: any stats/metric error logs once and skips the cycle; never affects serving.
- [ ] Commit: `feat(retention): scheduled corpus monitor and re-derivation baseline trend`

### Task 3: wire pruneReverted into the exemplar sweep

**Files:** Modify `src/core/ingest/scheduler.ts` (beside the `applyBucketCap` call at `scheduler.ts:379-391`), test beside the scheduler exemplar tests.

- [ ] Behind the existing `NLM_CODE_EXEMPLARS_ENABLED === "1"` gate, call `exemplars.pruneReverted(scope)` before the bucket cap; log the deleted count only when > 0.
- [ ] Test: reverted (survived=0) exemplars are pruned in the sweep; survived NULL and 1 are untouched.
- [ ] Commit: `feat(retention): prune reverted exemplars in the scheduler sweep`

### Task 4: canonical entity merge primitive (sqlite + pg parity)

**Files:** Extend the entity storage surface (find the port: grep `getEntities|session_entities` under `src/ports/` and `src/core/storage/`); both `sqlite-*` and `pg-*` adapters; shared contract tests (mirror the workstream store contract-test pattern). Check first whether the pg schema has `entity_variants`; if not, add the pg migration for it in this task.

**Pinned semantics (from the design doc):**

```
merge(source, target):
  - rewrites session_entities rows from source to target, dedup-safe on the
    composite PK (INSERT OR IGNORE the target rows, then DELETE the source rows,
    inside one transaction; pg: ON CONFLICT DO NOTHING equivalent)
  - recomputes target.session_count EXACTLY from session_entities (heals drift)
  - target.first_seen_session / last_seen_session widened to min/max across both
  - INSERT INTO entity_variants(variant, canonical, source_session_id) VALUES
    (source, target, NULL) so re-ingest binds the old surface form to the target
  - source entities row kept, status='retired', session_count=0
  - merging into a retired/missing target is an error (fail loud); merging a
    source with variants re-points those variants to the target
```

- [ ] TDD via shared contract tests run against both adapters (sqlite in-memory + pg gated).
- [ ] Ingest-side variant lookup: where session ingest writes `session_entities` (find it in the scheduler/ingest path), resolve each extracted entity through `entity_variants` first so merged surface forms bind to the canonical. One indexed SELECT per distinct entity; measure nothing, it is off the hot recall path.
- [ ] Commit: `feat(entities): canonical merge primitive with variant memory (sqlite + pg)`

### Task 5: dedup suggestion scorer + nlm entities dedup CLI

**Files:** Create `src/core/entities/dedup-suggest.ts` (pure), CLI subcommand in `src/cli/nlm.ts`, tests for both.

- [ ] Pure `suggestMerges(entities)` over `{canonical, sessionCount}` rows returning `{source, target, cls}` pairs; target = higher sessionCount. Classes: `safe` (case-fold + punctuation/whitespace-fold identical), `likely` (singular/plural, `-ts`/`-js`/`-py` style repo suffixes). Nothing else in v1; no embeddings (design doc records why).
- [ ] `nlm entities dedup`: default prints both classes with counts (dry run); `--apply-safe` executes safe-class merges via Task 4's primitive; `--interactive` steps through likely-class pairs with y/n. Summary line: merged / skipped / suggested-remaining.
- [ ] Commit: `feat(entities): conservative dedup suggestions with safe-class auto-apply`

### Task 6: docs, reviews, merge, board sync

- [ ] Per-task Sonnet reviews throughout; Opus whole-branch final review (storage-touching wave).
- [ ] Public-repo scrub over the unpushed range; NUL/em-dash/narration sweep.
- [ ] README or docs: short retention section (monitor thresholds, dedup runbook: dry-run, apply-safe, adjudicate likely; the Stage C gate pointer).
- [ ] Merge, push, `gh run watch` to green.
- [ ] Board: #353 notes (Stage A+B shipped, Stage C parked on the gate), close/annotate per outcome; note the operator runbook step (run dedup against the live corpus after daemon redeploy, Edward present for the first `--apply-safe`).
- [ ] CHANGELOG entry per session protocol.
