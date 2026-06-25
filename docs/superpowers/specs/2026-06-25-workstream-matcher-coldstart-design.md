# Workstream Matcher Cold-Start + Entity-Scoring (Plan E) — Design

> **SUPERSEDED 2026-06-25** by `2026-06-25-workstream-classifier-naming-design.md`.
> The Plan E pre-build dry-run (design Q2) measured every embedding-based approach against the locked
> gold and found ALL of them ceiling below flip-ready: cascade 10-16% precision (over-binds 33/33
> negatives), abstain single-pass 50% precision @ 5.9% recall, anchor-centroid+abstain (best) 57%
> precision @ 24% recall. Root cause: session embeddings cluster by ACTIVITY-TYPE, not project, so
> negatives sit at the same cosine as positives and no gate separates them. The E1+E2 hypothesis below
> is FALSIFIED. The replacement design binds by having the classifier NAME the project (validated:
> 71% precision, 0 wrong-project binds, 94% neg-abstain on label+summary alone — a conservative floor).
> Retained here for the falsification record only. Do not execute this doc.

> Status: DESIGN (written warm from the R3 runbook findings 2026-06-25). Execute in a FRESH session
> via writing-plans → subagent-driven-development. Resolves spec §18 (entity scoring) + the cold-start
> gap that blocked the Plan D R3 threshold derivation. Binding flag stays OFF until this lands and re-tunes.

## Why this exists (the R3 finding)

Plan D built the seed/backfill/flip machinery and ran the rollout runbook against the live
`~/.nlm/canonical.sqlite`. R1 (preconditions) and R2 (seed: 15 workstreams, 84 entities) passed.
R3 (gold + threshold derivation) hit the spec §17 gate — **the matcher cannot bind reliably**, so
the flip is correctly blocked.

**Gold set (locked, reusable):** `~/.nlm/eval/gold-matcher.jsonl`, 50 sessions, hand-labeled
independently by fan-out labelers from each session's own transcript (never the alias map), assembled
mechanically (label → workstream id via the `workstreams` table). Composition: **17 positive**
(this repo's own work ×9, plus 8 spread across 6 other seeded workstreams — a mix of ventures and
client sites) and **33 "none"** (sessions belonging to projects outside the 15-workstream seed: other
ventures, client sites, infra, content, and job-search work). Independence preserved; reuse this exact
file when re-tuning so runs are comparable (spec §16 locked-gold rule).

**Measured score distribution (DEFAULT_WEIGHTS {semantic:0.5, entity:0.5}, 0 sessions bound):**

| cohort | top-candidate score |
|---|---|
| correct positives (7 of 17) | 0.015 – 0.200 |
| negatives that surfaced any candidate (4 of 33) | 0.013 – 0.115 |

- Only **7/17 positives surface their correct workstream as a candidate at all**; only 11/17 surface
  any candidate; 6/17 have zero entity overlap with any seed.
- Positive and negative scores **overlap** — no threshold yields both acceptable precision and
  meaningful recall. At default `high=0.55` the backfill binds **nothing** (max score 0.20).

## Root cause (two compounding effects)

1. **Cold-start: the semantic half is dead.** The matcher's strong signal is `neighborScores` — the
   workstreams of semantically-similar *bound* sessions (`getWorkstreamIds(semanticSearch(...))`).
   Pre-backfill, **0 sessions are bound**, so that map is empty and `semantic * neighborScore = 0`
   for every candidate. The score collapses to `entity * jaccard` only. Chicken-and-egg: the matcher
   needs bound sessions to bind sessions.

2. **Jaccard under-scores entity overlap.** Session entity-sets are large (10–30 entities); seeded
   workstream entity-sets are small (5–23). `jaccard = |A∩B| / |A∪B|` punishes the large union: 3
   shared of 40 union = 0.075 → ×0.5 = 0.0375. Even a genuinely-relevant session scores near zero.
   This is the spec §18 "entity scoring is load-bearing / IDF deferred" open question, now shown to be
   material, not theoretical.

## Proposed approach (resolve both; re-tune against the locked gold)

Two independent improvements, each testable, then a re-tune:

### E1. Better cold-start entity scoring (resolves §18)
Replace (or augment) plain Jaccard with a metric that does not collapse for large session entity-sets.
Candidates to evaluate against the gold (pick by measured precision/recall separation, not by guess):
- **Overlap coefficient**: `|A∩B| / min(|A|,|B|)` — removes the large-union penalty; a session sharing
  most of a workstream's small entity-set scores high regardless of how many other entities it has.
- **IDF-weighted overlap** (spec §18): weight each shared entity by rarity across `workstream_entities`
  so a shared distinctive entity ("SqliteSessionStore") counts more than a generic one ("Docker").
  Needs an entity→document-frequency table (cheap: count workstreams per entity).
- Keep it in `scoreCandidates` (`match.ts`) so runtime + eval + backfill share it (spec §15). The
  weight split between the semantic and entity terms likely needs revisiting once entity scores are
  on a sane scale (entity term may dominate at cold-start by design, then yield to semantic as
  bindings accumulate).

### E2. Iterative bootstrap backfill (resolves cold-start)
Single-pass match-only backfill can't work when nothing is bound. Make it iterative:
- Pass 0: bind only the **high-confidence entity matches** (E1 metric ≥ a conservative cut) — these
  become the first semantic anchors.
- Pass N: re-run; now `semanticSearch` neighbors include bound sessions, so `neighborScores` lights
  up and sessions semantically similar to anchors bind even without entity overlap. Repeat until a
  pass binds < K new sessions (convergence) or a max-iteration cap.
- **Precision safeguard (load-bearing):** a wrong early bind propagates (its semantic neighbors inherit
  the error). So Pass 0 must be high-precision (favor a strict entity cut over coverage), and each
  pass should keep the bind threshold conservative. Consider only letting a session bind if the top
  candidate beats the runner-up by a margin (reduces ambiguous mis-binds during cascade).
- Stays `binding_source='backfill'` (reversible: `WHERE binding_source='backfill'`). Still NEVER
  creates a workstream, NEVER calls the LLM path.

### E3. Re-tune + decide
Re-run `tune-matcher` against the locked gold after E1/E2. Set `DEFAULT_THRESHOLDS` from the observed
separation (positives above, negatives below). The flip remains gated on the gold numbers being
acceptable (spec §17), not on a schedule. If E1+E2 still can't separate, the fallback is narrow-flip
(bind only the highest-confidence cohort) or expand the seed — but the goal is a real cut.

## Open design questions for the fresh session to resolve (against the gold, not by guess)
1. Overlap-coefficient vs IDF-overlap vs a blend — which gives the cleanest positive/negative
   separation on the locked gold? (Measure all three with the existing `_r3_dist`-style analysis.)
2. Does the iterative backfill actually cascade on the FULL corpus (4234 sessions), or do too few
   Pass-0 anchors bind to bootstrap? **Quantify with a reversible full-corpus dry-run** before
   committing to the iteration design — this is the single most important unknown. (My 50-session
   gold sample is too small to predict corpus-wide cascade behavior.)
3. Margin-based bind (top beats runner-up by δ) vs pure threshold — does the margin rule meaningfully
   cut mis-binds during cascade?
4. Weight re-split: at cold-start the entity term should dominate; should the weights be dynamic
   (entity-heavy until N sessions bound, then semantic-heavy), or is a fixed split with the improved
   entity metric enough?

## Constraints carried from Plan A–D (do not relitigate)
- One scoring source of truth: `scoreCandidates` in `match.ts`, shared by runtime/eval/backfill (§15).
- No re-embedding (embedder unchanged: LM Studio nomic-v1.5, 768-dim; corpus already embedded).
- Reversibility: backfill writes only `workstream_id` + `binding_source='backfill'`; never creates.
- Public-repo hygiene (nlm-memory is PUBLIC): `~/.nlm/*` operator files never committed; no home
  paths / IPs / unreleased venture names in committed code or fixtures; never stage
  `scripts/eval/judge-calibration.ts`.
- TDD; `npm run test` + `typecheck` (+ `build:server` for `match.ts`) before each commit.
- The flip (R6) stays Edward-gated, post-push, gated on the re-tuned gold numbers.

## What's already in place (don't rebuild)
- Seed loader works; 15 workstreams + 84 entities seeded in the live DB (idempotent re-run safe).
- `buildEmbedder()` shared module (eval/backfill embed via the configured LM Studio provider).
- Script entrypoint guards fixed (space-safe `fileURLToPath`); `dump-matcher-candidates` ordering fixed.
- Gold set locked at `~/.nlm/eval/gold-matcher.jsonl` — reuse it; do not relabel.
- `tune-matcher` wired to the real matcher; `scoreCandidates` extracted. `DEFAULT_THRESHOLDS` still
  provisional (0.55/0.3) — correctly unset pending this work.
