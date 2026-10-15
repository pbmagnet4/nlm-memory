# Memory improvement experiments and how we will judge them

Status: plan. Tracked as nxttasks T730 (E0 to E6 = T731 to T737). Origin: a review of a comparable open-source agent memory system, which showed ideas worth testing but no independently verifiable evidence that they help. So every idea here is an experiment with a stated metric and a kill criterion, not an adoption.

## Rules for every experiment

1. Hypothesis, metric, threshold and kill criterion are written down before the baseline run. Thresholds below are proposals, to be confirmed after E0 produces baselines.
2. Baseline and candidate run on the same frozen snapshot, same queries, same day.
3. Candidate ships behind a flag and in shadow mode (computes, logs, changes nothing) before it can change stored data or injected text.
4. A change that lowers fact recall at rank 1 is rejected regardless of other gains. Precedent: a corroboration boost once cut fact R@1 from 81% to 27% in eval (#527).
5. Judging by a model uses a different model family from the classifier under test, blind to which arm produced an item, and a sampled 10% is re-checked by a second judge.

## E0. Shared eval harness (T731, do first)

- **Snapshot**: a read-only copy of the live SQLite store, frozen by date. All experiments read the copy.
- **Golden queries**: real queries from the daemon's query logs. A session or fact counts as relevant when a later citation record points at it. Plus the existing `nlm eval --queries` format so the CI lane keeps working. Hold out 30% of queries for final scoring only.
- **Metrics** (one command, JSON out): session and fact R@1, R@5, MRR in keyword, semantic and hybrid modes; count of conflicting active facts (doctor I5a); fraction of facts missing an embedding; tokens injected per hook call; DB size by table; classify latency p50 and p95; the existing `nlm metrics re-derivation`; citation rate per surfaced session.
- **Impact eval**: reuse the existing blind causal-replay eval (judge win rate over decisive pairs) for any change that alters what an agent is shown.
- **Gate**: the harness runs in CI against a small committed synthetic corpus, and nightly against the snapshot.

## Experiments

| ID | Idea | Weakness targeted | Metric and threshold | Kill criterion |
|---|---|---|---|---|
| E1 (T732) | Re-embed facts that silently lack vectors; alarm when the drop rate exceeds 0.5% | About 3.8% of fact embeddings dropped (#435) | Missing-embedding share under 0.5% for 14 days; fact R@5 on the previously keyword-only facts up; no R@1 loss | Drop rate returns above 1% within 14 days, then find the cause before anything else |
| E2 (T733) | Guards on destructive sweeps: refuse if a sweep would touch more than 80% of rows or leave fewer than a floor; write an audit line | Retention and supersession sweeps can over-delete | Property tests: sweep on a synthetic store never crosses the guard; audit line present | None needed; low risk |
| E3 (T734) | On fact write, retrieve the top 5 similar existing facts and have a model choose keep, skip, supersede or merge-with-history, never overwrite | 44 single-valued groups with differing values, many extraction noise (#434, #446, #617) | Replay the history in order on the snapshot with the judge, no live writes. Conflict groups down 50% or more; false-supersession rate at most 2% on a 100-fact blind-judged sample; fact R@1 not lower; added classify latency per fact reported | False supersessions above 5%, or R@1 drops |
| E4 (T735) | A budgeted tiered block in hooks: a few high-priority items first, then more only while under a token cap | Hook-injected recall is rarely cited | Tokens per injection down 30% or more with citation rate and replay win rate no worse; run only after per-source precision is the reported number | No gain in citation rate or win rate, then keep the current block |
| E5 (T736) | Move large subagent and tool-output bodies to cold storage, keep summaries and ids in the hot DB | 1.8 GB database, subagent fragments about 315 MB | DB at least 15% smaller; golden-query R@5 unchanged; p95 body fetch under 200 ms. First measure whether those sessions are ever cited | Subagent bodies are cited often enough to hurt on fetch |
| E6 (T737) | Fact classes: state facts (latest wins) and event facts (all kept) with different supersession | Status-like facts conflict by nature | Fewer conflicts without losing event history; judged on the same blind sample as E3 | E3 already reaches its targets, then skip |

## Order

E0, then E1 and E2 (small, independent), then E3 in shadow, then E4 and E5, then E6 only if E3 leaves conflicts. E1 to E3 are all SQLite and daemon changes; E4 touches hooks; E5 touches storage. Use one worktree per experiment; each lands only with its metric report attached to the task.

## How we will decide it was meaningful

A result counts when it beats its threshold on the held-out queries and the snapshot, does not regress rule 4, and survives two weeks live in shadow with the same direction. Report numbers with sample sizes and say plainly when a gain is within noise.

## Not planned

Layered memory pyramids, a hosted multi-tenant hub, proxy-based capture, destructive merge, and adopting the external project. These solve problems we do not have, or remove the history we rely on.
