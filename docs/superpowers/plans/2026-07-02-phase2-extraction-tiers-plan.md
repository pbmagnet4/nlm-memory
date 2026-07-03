# Phase 2: Extraction Tiers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** NLM records which classifier produced every classification (provenance), any user can benchmark their configured classifier lane against shipped public gold (`nlm eval --classifier`), and upgrading to a stronger model retroactively improves the existing corpus (`nlm reprocess`), with published floor/mid/cloud operating points.

**Architecture:** Three nullable provenance columns on `sessions` (provider, model, confidence) threaded from `ClassifierBox` through both ingest paths into both storage backends. A shipped fixture set of synthetic agent transcripts with hand-authored reference extractions, scored deterministically by the existing `extraction-scoring.ts` math (no LLM judge), surfaces through `nlm eval --classifier`. `nlm reprocess` selects sessions by provenance (different model, low confidence, or pre-tracking NULL) and re-runs the full `insertSession` upsert, which already replaces markers and facts (#351 supersedence) and refreshes FTS and embeddings. A prerequisite task fixes the entity-link replace semantics that reprocess would otherwise amplify.

**Tech Stack:** TypeScript ESM, Vitest, better-sqlite3 + pg. No new dependencies.

## Global Constraints

- This repo is PUBLIC. No internal hostnames, IPs, or non-public project names in any committed text. Fixture content must be fully synthetic.
- No em dashes in ANY added text (self-check before commit: `git diff --cached | grep "^+"` must contain zero U+2014). No literal NUL bytes. No narration comments.
- Full gate after every task: `npm run typecheck` + `npm test`. Tasks touching pg run `npm run test:pg` (NLM_PG_TEST_URL, serial).
- Never commit anything under `.superpowers/`. `npm run build`; commit regenerated bundles if changed.
- **The classifier prompt is frozen.** `CLASSIFIER_SYSTEM_PROMPT`, `CLASSIFIER_JSON_SCHEMA`, the predicate vocabulary, and the coercion rules in `src/core/classifier/prompt.ts` must not change in this wave: the eval measures the shipped extraction behavior; changing it mid-wave invalidates the measurement.
- Out of fence: `src/llm/naming.ts`, `src/core/workstream/**` (a long-running backfill depends on them), `src/core/classifier/prompt.ts` (read-only per above).
- ZERO behavior change for existing flows except where a task explicitly states it (Task 2's entity replace semantics is the only intentional behavior change).
- Commit style: `feat(extraction): ...` / `fix(ingest): ...` / `docs: ...`, one commit per task.

---

### Task 1: Classification provenance columns + threading

**Files:**
- Create: `migrations/028_classifier_provenance.sql`, `migrations/pg/028_classifier_provenance.sql`
- Modify: the `IngestRecord` type (find via its construction at `src/core/scheduler/scheduler.ts:283-301`), `src/core/scheduler/scheduler.ts`, `src/core/ingest/ingest-session.ts`, `src/core/ingest/reclassify-oversized.ts`, `src/core/storage/sqlite-session-store.ts` (insertSession INSERT + ON CONFLICT SET), `src/core/storage/pg-session-store.ts` (same), `src/shared/types.ts` (Session type), row-mapping helpers
- Test: extend the existing insertSession/scheduler integration tests

**Migrations (same columns both backends):**

```sql
-- 028_classifier_provenance.sql
-- Which classifier produced this session's classification. NULL = classified
-- before provenance tracking; nlm reprocess treats NULL as eligible.
ALTER TABLE sessions ADD COLUMN classifier_provider TEXT;
ALTER TABLE sessions ADD COLUMN classifier_model TEXT;
ALTER TABLE sessions ADD COLUMN classifier_confidence REAL;
```

(pg variant: `ADD COLUMN IF NOT EXISTS`.)

**Threading contract:**
- `IngestRecord` gains optional `readonly classifier?: { readonly provider: string; readonly model: string; readonly confidence: number }`.
- Scheduler (`scan-once` path) and `ingestSession` (webhook path) populate it from the live `ClassifierBox` (`classifier.provider`, `classifier.model`) and `classification.confidence`. `reclassifyOversized` likewise.
- `insertSession` (both backends) writes the three columns and includes them in the ON CONFLICT UPDATE SET (a re-ingest by a new model must overwrite provenance).
- `Session` type and row mappers expose them as optional fields; `/api/classifier/info` is untouched.

- [ ] **Step 1: Failing tests**: insertSession round-trips provenance on fresh insert and overwrites on upsert (both backends); scheduler integration test asserts a scanned session lands with the box's provider/model and the classification's confidence; a record without the classifier field writes NULLs.
- [ ] **Step 2: RED, implement, full gate + pg, commit:** `feat(extraction): classification provenance on sessions (provider, model, confidence)`

---

### Task 2: Entity-link replace semantics on re-ingest

Pre-existing defect that `nlm reprocess` would amplify corpus-wide: `insertSession` uses `INSERT OR IGNORE` for `session_entities` (sqlite-session-store.ts:338-357; pg equivalent), so entities dropped by a re-classification stay linked forever, and the touch logic increments `entities.session_count` on every re-ingest (double counting).

**Files:**
- Modify: `src/core/storage/sqlite-session-store.ts` (entity block in insertSession), `src/core/storage/pg-session-store.ts` (same)
- Test: new integration test file or extension proving re-ingest stability

**Behavior contract (the wave's one intentional behavior change):**
1. On insertSession for an EXISTING session id: delete the session's `session_entities` rows, then insert links for the new entity list (mirroring how markers already do DELETE + re-insert).
2. `entities.session_count` must reflect reality after re-ingest: recompute as `COUNT(*) FROM session_entities WHERE entity_id = ?` for every entity touched (both the removed and added sets), rather than blind increment. Keep `last_seen_session` semantics for added entities.
3. Fresh inserts behave identically to today.
4. Entities orphaned to zero links are left in place (no cascade delete of the entities row; that is curation, not ingest).

- [ ] **Step 1: Failing tests**: ingest a session with entities [A, B]; re-ingest same id with [B, C]; assert links are exactly [B, C], A's session_count decremented to its true count, C linked, B's count unchanged (not double-incremented). Run twice more and assert counts are stable (idempotent). Both backends.
- [ ] **Step 2: RED, implement, full gate + pg, commit:** `fix(ingest): replace entity links on re-ingest and keep entity session_count exact`

---

### Task 3: Shipped classifier gold fixtures + scorer wiring

**Files:**
- Create: `tests/fixtures/classifier-gold/transcripts/` (20 synthetic transcripts, `.txt`), `tests/fixtures/classifier-gold/reference.json`, `tests/fixtures/classifier-gold/README.md`
- Create: `src/core/eval/classifier-fixture-eval.ts` (pure logic, no CLI)
- Test: `tests/unit/core/eval/classifier-fixture-eval.test.ts`

**Fixture contract:**
- 20 fully synthetic agent-work transcripts, 1-6K chars each, spanning: coding sessions (bug fix, feature, refactor), ops/infra work, research/writing, a meeting-notes style session, plus at least 3 low-signal/trivial sessions where the correct behavior is LOW confidence (<= 0.4 per the prompt's own instruction). Content must read like real work but reference only invented projects, invented names, example.com domains.
- `reference.json`: per transcript id: expected `label` (plus acceptable alternates array), expected entities (set), expected decisions (set), `expectLowConfidence: boolean`. References are hand-authored against the FROZEN prompt contract (closed predicate vocabulary for any expected facts; keep expected facts optional per fixture since validateClassifierJson does not require facts).
- Scoring in `classifier-fixture-eval.ts` reuses `scripts/eval/extraction-scoring.ts` math where it fits (entity/decision precision+recall); move/import that module rather than duplicating (if importing from scripts/ into src/ is awkward, relocate the pure functions into `src/core/eval/extraction-scoring.ts` and repoint the script import; zero logic change).

**Produces (consumed verbatim by Task 4):**

```typescript
export interface FixtureEvalResult {
  readonly perTranscript: ReadonlyArray<{
    readonly id: string;
    readonly schemaValid: boolean;
    readonly labelMatch: boolean;
    readonly entityPrecision: number;
    readonly entityRecall: number;
    readonly decisionPrecision: number;
    readonly decisionRecall: number;
    readonly confidence: number;
    readonly confidenceCalibrated: boolean;
    readonly elapsedMs: number;
  }>;
  readonly aggregate: {
    readonly schemaValidRate: number;
    readonly labelAccuracy: number;
    readonly entityF1: number;
    readonly decisionF1: number;
    readonly confidenceCalibrationRate: number;
    readonly p50LatencyMs: number;
    readonly p95LatencyMs: number;
  };
}

export async function runClassifierFixtureEval(
  classify: (transcript: string) => Promise<ClassifyResult>,
  fixturesDir: string,
  opts?: { readonly limit?: number },
): Promise<FixtureEvalResult>;
```

`confidenceCalibrated` = (expectLowConfidence and confidence <= 0.4) or (not expectLowConfidence and confidence > 0.4). Schema failures (ClassifierSchemaError after retries) count as schemaValid=false with zeroed metrics, never a thrown eval.

- [ ] **Step 1: Author fixtures + references first** (they are the deliverable; write them carefully, they are public), then failing unit tests for the scorer using a stub classify function (perfect answers = perfect scores; garbage = zeros; schema-error = counted not thrown; low-confidence calibration both directions).
- [ ] **Step 2: RED, implement, full gate, commit:** `feat(extraction): shipped classifier gold fixtures + deterministic fixture eval`

---

### Task 4: `nlm eval --classifier`

**Files:**
- Modify: `src/cli/nlm.ts` (the existing `eval` command at ~line 700: add `--classifier` flag; when present, ignore `--queries` and run the fixture eval against the CONFIGURED lane via `buildStack().classifier`; `--json` supported; `--limit N` for a quick smoke)
- Test: CLI-level integration test with a stubbed classifier (assert report shape and that recall mode is untouched when the flag is absent)

**Output contract:** human mode prints an aggregate table (schema validity, label accuracy, entity F1, decision F1, confidence calibration, p50/p95 latency) plus the lane identity line (`provider/model` from the ClassifierBox) and a pointer to the baselines table in docs; `--json` emits the full FixtureEvalResult plus `{provider, model}`. Existing `nlm eval --queries` behavior byte-identical.

- [ ] **Step 1: Failing CLI test, RED, implement.**
- [ ] **Step 2: Manual smoke against the live configured lane** (`nlm eval --classifier --limit 3`), full gate, commit: `feat(extraction): nlm eval --classifier benchmarks the configured lane against shipped gold`

---

### Task 5: `nlm reprocess`

**Files:**
- Create: `src/core/ingest/reprocess.ts`
- Modify: `src/cli/nlm.ts` (new `reprocess` command; template: `backfill-facts` at ~line 1054 for options/state conventions, `reclassify-oversized` at ~line 1092 for the full-insertSession pattern)
- Test: `tests/integration/reprocess.test.ts` (sqlite; pg variant if time permits, else file a follow-up in the report)

**Selection contract (provenance-driven, from Task 1's columns):**
- Eligible: sessions with `body IS NOT NULL` AND (`classifier_model IS NULL` OR `classifier_model != <current lane model>` OR `classifier_confidence < --min-confidence` when that flag is passed).
- `--dry-run` prints the cohort report: counts grouped by (classifier_provider, classifier_model, confidence band) and exits without writes.
- Order: `started_at DESC` (recent sessions are worth upgrading first). `--limit N` supported; resumable state file (`~/.nlm/reprocess.state`, same JSON shape conventions as embed-backfill, recording the lane it was started under; a lane change invalidates the done-set).

**Reprocess contract per session:**
1. Re-run `classifyAdaptive` on the stored `body` with the configured lane (respect the existing per-call timeout convention from the scheduler).
2. On classify failure: skip, count, continue (never abort the run; report failures).
3. On success: full `insertSession` upsert with the embedder passed (so chunks and fact embeddings refresh), facts via the existing fact sink (the #351 machinery replaces them), and the new provenance written. Confidence floor does NOT gate overwrites here (the operator explicitly chose to reprocess; a below-floor result still overwrites but is counted separately in the report). Log old vs new confidence per session at verbose level.
4. Workstream binding is intentionally untouched (binding columns are not in the upsert SET); state this in the command's help text.
5. Report: total eligible, processed, succeeded, failed, skipped-already-done, belowFloorOverwrites, mean confidence old vs new.

- [ ] **Step 1: Failing integration tests**: seed sessions with mixed provenance (NULL, different model, low confidence, current model); assert selection picks exactly the right set; run with a stub classifier and assert label/summary/markers/facts/provenance replaced, embeddings refreshed (chunk rows present), entity links replaced (Task 2 behavior), binding untouched; dry-run writes nothing; resume skips done ids.
- [ ] **Step 2: RED, implement, full gate, commit:** `feat(extraction): nlm reprocess upgrades prior classifications under a stronger lane`

---

### Task 6: LongMemEval harness honors the configured lane

`scripts/longmemeval/run-harness.ts` hardwires ollama/deepseek clients (`buildClassifierClient`, lines ~98-103), so `openai`-provider lanes (any OpenAI-compatible endpoint) cannot be benchmarked with the public dataset.

**Files:**
- Modify: `scripts/longmemeval/run-harness.ts` (accept `--classifier configured` which uses `buildClassifier()` from the env-configured lane; keep existing `provider:model` forms working; cache key must incorporate the resolved provider+model exactly as today)
- Test: unit test on the flag parsing if a test file exists for it; otherwise verify by `--help` and a `--limit 1` smoke run documented in the report

- [ ] **Step 1: Implement, smoke, full gate, commit:** `feat(eval): longmemeval harness runs the env-configured classifier lane`

---

### Task 7: Tier expectations docs

**Files:**
- Create: `docs/classifier-tiers.md`
- Modify: `docs/methodology-recall-baseline.md` (cross-link), `docs/eval-classifier.md` (point at `nlm eval --classifier` as the first-run step)

**Content contract for `docs/classifier-tiers.md`:**
- The three operating points: floor (4B-class local via Ollama), mid (20-30B-class via any OpenAI-compatible endpoint), cloud API. One frozen prompt contract across all three.
- How to measure YOUR lane: `nlm eval --classifier` (minutes, shipped gold) and `npm run bench:classifier` (LongMemEval public dataset, hours, retrieval-level attribution).
- A baselines table with columns (tier, example model, schema validity, label accuracy, entity F1, decision F1, calibration, p50 latency) and a `TBD pending baseline runs` marker for rows not yet measured: DO NOT invent numbers. The operator (not this wave) fills rows from real runs.
- The upgrade path: measure, swap lane env vars, `nlm reprocess --dry-run`, reprocess, and what improves (labels, entities, facts) vs what does not (workstream bindings, old citations).
- Honest limitations: provenance starts NULL for pre-tracking corpora; reprocess costs one classify call per session; the corpus-specific R@5 baseline (90.0% personal corpus; the 97.2% figure is the public LongMemEval-S run, corrected 2026-07-03) per methodology doc.

- [ ] **Step 1: Write docs, run a docs-only gate (typecheck+test untouched but run anyway), commit:** `docs: classifier tier expectations and upgrade runbook`

---

## Verification (whole wave, controller-run)

1. Full suite + serial pg pass green; CI green after push.
2. Live smoke: `nlm eval --classifier` against the operator's configured lane produces a real scored report; `nlm reprocess --dry-run` on the live corpus reports the pre-tracking cohort (expected: nearly all sessions NULL-provenance).
3. Grep gates: no em dashes in added lines, no NUL bytes, no internal names in fixtures or docs.
4. Baseline runs (post-wave, operator task): floor and cloud rows of the baselines table filled from real `nlm eval --classifier` runs; published in a follow-up docs commit.

## Out of scope

- Changing the classifier prompt or predicate vocabulary (frozen for measurement validity).
- Fact-level model provenance (facts inherit session provenance via source_session_id).
- Reprocessing sessions that were skipped at ingest for low confidence (they have no session row).
- Workstream rebinding after reprocess (separate tooling exists; binding is preserved).
- LLM-judge scoring in the shipped eval (deterministic reference scoring only; the private judge-based classifier-eval.ts remains a local tool).
