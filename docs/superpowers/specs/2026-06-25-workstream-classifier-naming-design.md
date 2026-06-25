# Workstream Binding by Classifier-Naming (Plan E, revised) — Design

> Status: DESIGN (written warm 2026-06-25 from the Plan E pre-build measurement). Supersedes
> `2026-06-25-workstream-matcher-coldstart-design.md`. Execute via writing-plans → subagent-driven-
> development. Binding flag `NLM_WORKSTREAM_BIND` stays OFF until this lands and the gold gate passes.
> Edward confirmed direction: classifier-naming, retire the embedding bind.

## Why this exists (the measurement that killed the embedding matcher)

Plan D shipped the seed/backfill/flip machinery; its R3 runbook hit the spec §17 gate (matcher not
flip-ready). Plan E was first designed as "better entity scoring + iterative bootstrap cascade." Before
building, the design's own Q2 (reversible full-corpus dry-run) was run read-only against the live
`~/.nlm/canonical.sqlite`. It falsified that design and, more importantly, falsified the whole
embedding-based approach. Measured against the locked 50-session gold (17 positive / 33 "none"):

| Approach | Coverage | Precision | Notes |
|---|---|---|---|
| Iterative cascade (old E2) | 97.6% | 10–16% | over-binds; binds all 33/33 negatives |
| Abstain single-pass (top-K + IDF entity) | 8% | 50% @ 5.9% recall | under-binds; `semanticSearch` top-10 surfaces activity-type neighbors, buries project-mates |
| Anchor-centroid + abstain (best embedding) | — | **57% @ 24% recall** | ceiling; negatives sit at the same cosine as positives |

**Root cause (decisive):** session embeddings cluster by **activity-type** (code-review, refactor,
research), not by **project**. An NLM matcher session's nearest clean anchor was an unrelated project's
coding session. Entity overlap is the only project-specific signal and it is too sparse (only 7/17 positives
share an entity with their correct workstream) and too noisy (small workstreams produce spurious
perfect overlaps). No scorer redesign moves a 57% precision ceiling to flip-ready.

**The signal embeddings lack is content.** The classifier reads the transcript and can name the
project directly. Validation (`scripts/eval/_r3e-classifier-naming.ts`, qwen3.5-4b on LM Studio,
**label+summary only** — a conservative floor; the product reads the full 32K transcript): **71%
precision (5/7 binds, ZERO wrong-project binds), 29% recall, 94% negative-abstain (31/33).** It beats
every embedding approach and never bound a positive to the wrong workstream — its only errors are
conservative "none" calls and 2 negative false-binds. Full-transcript context, alias/entity hints, and
a tuned prompt are clear levers to raise recall while holding precision.

## Approach: bind by the classifier naming the project

Replace the embedding decision (`buildMatchInputs` + `matchWorkstream`) with: the classifier names the
session's project from the seeded workstream list (or "none"); the named label is matched to a seeded
workstream and bound; "none" / no-match abstains. Content-driven, abstain-first by construction.

### Ground-truth seams (verified against the live code)
- `ClassifyResult` (`src/ports/llm-client.ts`) has `label`, `summary`, `entities`, `decisions`,
  `open`, `confidence`, `facts` — **no project field**. Add one.
- The scheduler forward-binds via `bind.ts` `bindSessionToWorkstream` (currently `buildMatchInputs` +
  `matchWorkstream` + `pickAmbiguous` + `createOrDedup`), gated by `NLM_WORKSTREAM_BIND` (`scheduler.ts:48`).
- `findByNormalizedLabel(normalizeLabel(label))` (`workstream-store.ts`) is the name→workstream
  primitive. The alias→canonical map lives in `~/.nlm/work-topics.json` (the same map the seed loader
  and work-digest `aliasTopicProvider` read).
- Downstream of the decision (`setWorkstreamBinding`, `upsertEntities`, `touchLastSession`) is reused
  unchanged.
- **Thinking-model gotcha (load-bearing):** qwen3.5-4b spends its token budget on hidden reasoning.
  `max_tokens=300` → `finish_reason=length`, **empty content**. Needs ≥2000 (validation used 4000).
  The production project-naming call MUST budget for thinking (or send `/no_think`), or it silently
  returns "none" for everything.

### The pieces
1. **Classifier project-naming.** A naming call that takes the candidate workstream labels (+ their
   aliases from `work-topics.json` as hints) and the session content, and returns one label or "none".
   Either a new field on the existing `classify()` (near-free at ingest) or a dedicated lightweight
   call. Decide in the plan: extending `classify()` couples re-classification to re-binding; a separate
   `nameWorkstream()` keeps them independent and is cheaper to re-run for backfill. **Leaning separate
   call** (single responsibility; backfill re-runs naming without re-extracting facts).
2. **Name-match binding decision.** New pure function `decideWorkstreamByName(namedLabel, workstreams,
   aliasMap)`: normalize → exact seeded-label match → alias-map match → else abstain. Returns
   `{ kind: "bind", workstreamId } | { kind: "abstain" }`. Replaces `matchWorkstream` as the decision
   for both forward bind and backfill. **Never creates** in backfill; forward MAY `createOrDedup` only
   if Edward wants new-project creation on (default: abstain to keep the seeded set clean).
3. **Rewire `bind.ts`.** Swap the embedding decision for `nameWorkstream()` + `decideWorkstreamByName()`.
   Keep `setWorkstreamBinding`/`upsertEntities`/`touchLastSession`. `binding_source` stays `"classifier"`
   forward, `"backfill"` for the historical run (reversible `WHERE binding_source='backfill'`).
4. **Backfill rewrite.** `scripts/backfill-workstreams.ts` runs `nameWorkstream()` over the labelled
   corpus (full transcript where available for recall), binds matches `binding_source='backfill'`,
   abstains on "none". Local Studio lane (free), `--dry-run` gate, reversible.
5. **Retire the embedding decision.** `match.ts` (`scoreCandidates`/`matchWorkstream`/`jaccard`),
   `build-match-inputs.ts`, and the embedding-specific `bind.ts` deps come out of the bind path. Keep
   them only if a fallback is wanted — Edward chose **retire**, so delete the decision usage and the
   now-dead matcher modules (and their tests), per DRY/no-dead-code. The seed loader, lifecycle tools
   (rebind/merge/rename/retire), storage schema, gold harness, and `work-topics.json` all stay.

### Tuning + gate
- Tune the naming prompt + token budget + hint set against the **locked gold** (reuse
  `~/.nlm/eval/gold-matcher.jsonl`; do not relabel). Target: hold precision high (≈0 wrong-project) and
  push recall up from the 29% floor via full transcript + alias/entity hints.
- The flip (`NLM_WORKSTREAM_BIND=true`) stays OFF, Edward-gated, post-push, gated on the gold numbers
  (precision/recall), not a schedule.

## Open questions for the plan to resolve (measure, don't guess)
1. Extend `classify()` vs a separate `nameWorkstream()` call? (Leaning separate — single responsibility,
   independent backfill.)
2. Full 32K transcript vs label+summary for backfill — measure the recall/cost tradeoff on the gold
   (and on a sample of the 4276, since transcript reads are slower).
3. Alias/entity hints in the prompt — do they lift recall without hurting precision on the gold?
4. The 2 negative false-binds from validation — examine; does a confidence/abstain instruction or a
   "only if clearly one of these" guard remove them?
5. Forward-bind create-on-no-match: ON (auto-create new workstreams) or OFF (abstain to seeded set)?
   Default OFF; revisit once the seed covers the corpus.

## Constraints carried from Plan A–D (do not relitigate)
- Reversibility: backfill writes only `workstream_id` + `binding_source='backfill'`; never creates.
- No re-embedding (this approach doesn't use embeddings for binding at all).
- Public-repo hygiene (nlm-memory is PUBLIC): `~/.nlm/*` operator files never committed; no home
  paths / IPs / unreleased venture names in committed code or fixtures; never stage
  `scripts/eval/judge-calibration.ts`. The `_r3e-*.ts` throwaway harnesses stay untracked.
- TDD; `npm run test` + `typecheck` (+ `build:server` for daemon-graph code) before each commit.
- No-em-dash rule in any committed strings/output (Edward's hard rule).
- The flip (R6) stays Edward-gated, post-push, gated on the re-tuned gold numbers.

## What's already in place (don't rebuild)
- Seed loader works; 15 workstreams + 84 entities seeded (idempotent). Note: the seed is narrow
  (~34% corpus coverage); seed expansion is a separate future track, not part of this design.
- Lifecycle tools (rebind/merge/rename/retire/merge-suggest) shipped (Plan C).
- Gold set locked at `~/.nlm/eval/gold-matcher.jsonl` — reuse; do not relabel.
- Validation harness `scripts/eval/_r3e-classifier-naming.ts` (untracked) measures naming vs gold —
  the basis for the tuning step.
