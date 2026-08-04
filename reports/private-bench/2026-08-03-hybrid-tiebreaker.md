# Private bench re-run: hybrid metadata tiebreaker (#394 fix)

Run date: 2026-08-03. Same locked gold set (n=50) and the same
`snapshot-2026-07-06.sqlite` corpus as the 2026-07-06 first run, so corpus growth
cannot confound the comparison. Only the code changed.

Change under test: commit `6da68a5`, which passes `queryTokens` into `finalize()`
on the hybrid leg. Before it, the #308 metadata tiebreaker reached only the keyword
leg. The fix had been gated behind the #393 measurement window, which closed clean
earlier the same day.

## Aggregate

| Mode | R@1 | R@3 | R@5 |
|---|---|---|---|
| keyword (07-06) | 24.0% | 72.0% | 88.0% |
| keyword (08-03) | 24.0% | 72.0% | 88.0% |
| hybrid (07-06) | 8.0% | 54.0% | 74.0% |
| **hybrid (08-03)** | **18.0%** | **62.0%** | **80.0%** |
| hybrid delta | +10.0pp | +8.0pp | +6.0pp |

Keyword is byte-identical across runs, which confirms the change was isolated to
the hybrid path as intended.

In absolute terms on n=50 the hybrid gains are 5, 4, and 3 queries respectively.
Small sample, so read the magnitude as directional. What raises confidence above a
single number is that all three cutoffs moved the same way on a paired comparison
against an unchanged corpus and an unchanged control arm.

## The 2026-07-07 diagnosis was partially wrong

That investigation concluded the hybrid drag was "ENTIRELY the metadata tiebreaker
never reaching hybrid's finalize path." Fixing exactly that recovered 6 of the
14pp gap at R@5. **An 8pp hybrid-vs-keyword drag remains** (80.0 vs 88.0), so the
tiebreaker was a real cause but not the only one. The one-parameter fix was
correctly scoped; the attribution around it was overstated.

## Where the residual drag lives

| Category | keyword R@5 | hybrid R@5 | gap |
|---|---|---|---|
| temporal | 100.0% (n=8) | 62.5% (n=8) | **-37.5pp** |
| config-lookup | 100.0% (n=8) | 87.5% (n=8) | -12.5pp |
| bug-resolution | 87.5% (n=8) | 87.5% (n=8) | 0 |
| decision-recall | 100.0% (n=8) | 100.0% (n=8) | 0 |
| multi-session | 70.0% (n=10) | 70.0% (n=10) | 0 |
| status-check | 75.0% (n=8) | 75.0% (n=8) | 0 |

The residual is not spread evenly: it is almost entirely temporal queries, with a
smaller config-lookup component. Four of six categories are now dead even.

This is a concrete lead rather than a mystery. `RecallService` already has a
temporal path — `detectQueryShape` plus `forceIncludeKeywordTop`, which fires only
when a query has BOTH a temporal marker and a named entity. Temporal queries that
carry no named entity fall through to plain hybrid merge, where the semantic leg
can displace the keyword hit that actually answers a date-scoped question. That
condition is the first thing to examine.

Caveat on the category tables: n=8 per category, so a single query is 12.5pp. The
temporal gap is three queries. Treat the ranking of categories as a lead to
investigate, not a measured effect size.

## Status

The R@1 half of #394 stays closed: the 70-to-24 collapse was gold-set composition
(the June set was decision-queries-only, the tiebreaker's home turf), not a
regression. Note that decision-recall now scores 100% in both modes, consistent
with that explanation.

Public-facing numbers were not updated. `reports/private-bench/2026-07-06-first-run.md`
remains accurate as a record of that run; this file supersedes its hybrid figures
for current-code purposes.
