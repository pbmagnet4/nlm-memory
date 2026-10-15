# Predicate-level fact classes (E6)

Experiment E6 of [the memory experiments plan](plans/2026-10-15-memory-improvement-experiments.md). No model judgment: a fixed table says which predicates are `state` (latest value wins, the long-standing ingest collapse) and which are `event` (every fact is kept, none superseded). E3's model judge failed on false supersession ([fact-judge.md](fact-judge.md)); this tests whether the predicate alone separates conflicts from replacements.

## Behaviour

`src/core/facts/fact-classes.ts` holds the table. `factClassOf(predicate)` returns `event` for the table's event predicates (`endpoint`, `owner`, `repo`, `runtime`, `version`) and for any string outside the closed predicate vocabulary (safe default: never superseded by the class rules), and `state` for every other vocabulary predicate (no conflict evidence, behaviour unchanged).

| Surface | Effect |
|---|---|
| Doctor I5a, harness `conflictingActiveFacts` | Event predicates join the exempt set (reported under I5a-mv). Always on |
| Ingest collapse (`sqlite-fact-store`, `pg-fact-ingest`), `batchWinners` embedding set | With `NLM_FACT_CLASSES=on`, event-class facts supersede nothing and each batch fact is kept and embedded. Default `off`: unchanged |
| Write-time judge | With `NLM_FACT_CLASSES=on`, event-class facts are not judged |

## How the table was derived

The 44 conflicting groups on the 2026-10-15 snapshot (I5a: more than one active fact for a (subject, predicate), exempt predicates excluded) spread over 8 predicates: status 27, model 5, host 3, version 2, runtime 2, repo 2, endpoint 2, owner 1. Each group was read once and labelled by one reader (no second labeler):

- R: the later value makes the earlier one false as current state (a true replacement).
- D: the same meaning restated (superseding is harmless).
- E: distinct facets or successive observations that are all still true.

| Predicate | Groups | R | D | E |
|---|---|---|---|---|
| status | 27 | 6 | 1 | 20 |
| model | 5 | 1 | 1 | 3 |
| host | 3 | 1 | 1 | 1 |
| endpoint, runtime, version, owner | 7 | 0 | 0 | 7 |
| repo | 2 | 0 | 2 | 0 |
| Total | 44 | 8 | 5 | 31 |

A predicate is `event` only if none of its groups is R. Only 8 of 44 conflicts are true replacements, but 6 of those 8 sit inside `status`, which is 20-of-27 event-like. No predicate-level table gets both goals:

| Table | Groups exempted | Of those, true state changes wrongly exempted |
|---|---|---|
| Shipped (event iff no R group) | 9 (-20%) | 0 (2 are D: a duplicate stays visible) |
| Plus `status` as event | 36 (-82%) | 6 |
| Every predicate with a majority of E or D as event | 44 (-100%) | 8 |

## Result: 2026-10-15 snapshot (T737)

Clone of the snapshot; the live store was never opened. `npm run eval:fact-class-replay -- <snapshotDir> --out-dir=<dir>` un-collapses event-class facts on the clone (6,137 facts whose successor shares their subject and predicate become active again and are re-embedded, 0 failures), as `NLM_FACT_CLASSES=on` would have left them. Then `eval:harness -- run` and `compare` against the day's baseline.

| Measure | Baseline | Shipped table |
|---|---|---|
| Conflicting active-fact groups (I5a) | 44 | 35 (-20%) |
| Fact R@1 semantic, dev / held-out | 64.7% / 64.8% | 63.0% / 63.9% (-1.8 / -0.8 pt) |
| Fact R@1 hybrid, dev / held-out | 64.0% / 63.9% | 62.2% / 63.1% (-1.8 / -0.8 pt) |
| Fact R@5 hybrid held-out | 98.4% | 95.1% (-3.3 pt) |
| Session metrics, hook tokens, citation | | unchanged |

The I5a exemption alone costs nothing (a reporting change); the R@1 loss comes from keeping the older event facts active, which then compete with the current one.

Verdict: fails both thresholds. Conflicts fall 20% against a 50% target, and fact R@1 drops, which is the kill criterion. Do not enable `NLM_FACT_CLASSES=on`. The I5a exemption stays: it removes 9 groups none of which was a true replacement.

Limits: one reader labelled the groups; the snapshot is one store; the fact goldens require a (subject, predicate) unique among active facts, so reviving same-key facts can only hurt them (the synthetic labels cannot reward keeping history); the replay un-collapses only collapse-origin supersessions of the five event predicates, not what a live ingest would have produced over time.

Next step if the 36 non-replacement conflicts matter: a group-level rule (value type, such as a path versus a name) rather than a predicate-level one; `status` carries 27 of the 44 and no class split of it is safe.
