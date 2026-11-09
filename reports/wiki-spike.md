# T1612 wiki spike report

Timeboxed spike: per-workstream wiki pages (decisions, open loops, key facts,
links back to member sessions) plus a deterministic ablation on multi-hop
questions only.

## What was built

- `src/core/wiki/workstream-pages.ts` — pure page/index builders over
  `WorkstreamRollup`-shaped inputs (`Workstream` + member `Session[]` +
  `Fact[]`), reusing `slugify`/`RenderedPage` shapes. No new stores; no IO.
  Session links are relative `` `session:<id>` `` spans, never absolute links.
- `scripts/eval/wiki-spike-eval.ts` — deterministic ablation, no model.
- `tests/unit/core/wiki/workstream-pages.test.ts` — 10 unit tests.

## Ablation (12 hand-labelled 2-hop questions, 4 workstreams x 3 sessions)

| arm | hits | rate |
|---|---|---|
| search-alone (best-session token recall) | 9/12 | 75.0% |
| wiki+search (fixed 0.5 session + 0.5 page blend) | 12/12 | 100.0% |

Search-alone misses are all cross-workstream term collisions resolved by
alphabetical tie-break (`redis latency` -> auth, `stripe offline` -> billing,
`postgres budget` -> billing). The wiki page, as the union of a workstream's
sessions, holds both hop-terms and wins those three outright.

Borges guard: wiki bytes / source session bytes = **0.077** (limit 0.5) —
PASS. Fixture sessions carry ~1.5KB neutral bodies so the denominator is
representative; the neutral vocabulary is asserted disjoint from every query
token, so it cannot move either arm's score.

Reproduce: `npx tsx scripts/eval/wiki-spike-eval.ts`

## Decision: KEPT BEHIND FLAG (not shipped, not deleted)

Spike code stays, gated behind `NLM_WIKI_WORKSTREAM` (default off, `1`/`true`
to enable). Why keep rather than delete: the ablation signal is positive on
both axes (+25pp recall, 13x under the size cap) and the code is small, pure,
and inert when the flag is off. Why not ship: the fixture is synthetic and
the scorer is keyword overlap, not the real recall stack.

## Recommendation: NO-SHIP pending live validation

Do not productize until (a) the eval is re-run against a live-corpus sample
with the real `RecallService` as the search-alone arm, and (b) N >= 50
hand-labelled multi-hop questions. If no owner picks that up within one
cycle, delete the three spike files.
