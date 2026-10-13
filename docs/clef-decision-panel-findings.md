# Clef decision panel findings

Interim memo for the plan in `docs/superpowers/plans/2026-10-10-clef-decision-panel.md` (T533). It covers H2, the only hypothesis fully run. All numbers are aggregates; the session text and labels stay outside the repo in `~/.nlm/eval/triage`.

## What was tested

H2: one Clef call per session asks a panel of typed questions (kind, a 0 to 3 importance score, four flags). The importance score gates the generative classifier call: sessions scoring under a threshold would skip it.

- Sample: 120 real sessions from `build-classifier-gold.ts` (72 weighted toward sessions that were later cited, 48 stratified by runtime and length). 98 claude-code, 22 other runtimes.
- Labels: pass 1 by four labelers that skimmed long sessions (rejected as gold); pass 2 by twelve labelers required to read each session in full and quote evidence from its last third (115 of 120 quotes verified against the text); the 16 sessions where the two passes disagreed on the gate boundary were adjudicated blind by a stronger model reading each in full. Final importance: 6 at level 0, 32 at 1, 68 at 2, 14 at 3.
- Gate target: a session is worth the classifier call when its audited importance is 2 or more.
- Split: a fixed hash of the session id, 57 tune and 63 holdout sessions. The threshold was chosen on tune only (the highest one that kept every worthwhile session), then read on holdout.

## Result

| Measure (holdout, 63 sessions: 43 worthwhile, 20 not) | Value |
|---|---|
| AUC of the importance score | 0.943 |
| Threshold chosen on tune | 1.5 |
| Worthwhile sessions skipped | 0 of 43 (Wilson lower bound on kept: 92%) |
| Not-worthwhile sessions skipped | 11 of 20 (55%) |
| All sessions skipped | 11 of 63 (17%) |
| Same threshold, sessions never cited only (25 sessions) | 40% of all sessions skipped, 0 worthwhile skipped |
| Importance within one level of the label | 120 of 120 |
| Session kind exact match | 99 of 120 |

Against the proposed adoption bar (no worthwhile session skipped, at least 20% of sessions skipped) the holdout passes the first condition and falls just short of the second (17%). The never-cited subset, which is closer to ordinary traffic, skips 40% but has only 25 sessions.

## What to trust and what not to

- Zero misses on 43 worthwhile sessions still allows a true miss rate of several percent. A gate that drops a substantive session loses that session's extraction, so adoption needs more labeled positives, and a shadow period that logs the decision without acting on it.
- The sample over-represents cited (so mostly substantive) sessions. The real share of skippable sessions is probably higher.
- Labels are noisiest exactly at the 1 versus 2 boundary where the threshold sits. Pass 1 and pass 2 agreed on the gate side for 104 of 120 sessions, and on exact importance for 91. The adjudicator sided with pass 2 on 11 of the 16 disputes.
- Clef call time: the fastest call was 1.05 s, but the median in this run was 6.4 s because the Studio was serving other work (including a classifier job started for the comparison below). Use about 1 s as the clean figure and re-measure at adoption.
- Calibration comparison is not usable: the production classifier was stopped after 15 sessions (2 unparsed). Its self-reported confidence was exactly 1.0 on every parsed one, so it carried no signal on those sessions, but 13 sessions is too few to conclude more.

## H2 at scale: 799 historical sessions against stored output

A seeded random sample of 799 closed sessions (`scripts/eval/clef-yield.ts`), each scored by Clef and compared with what the classifier stored for it (decision markers and live facts). The threshold stayed at 1.5, frozen from the audited tune set.

| Threshold | Sessions skipped | Stored-nothing sessions skipped | Decisions lost | Facts lost |
|---|---|---|---|---|
| 1.25 | 21.4% | 134 of 246 | 10 of 3012 (0.3%) | 63 of 3868 (1.6%) |
| 1.5 | 28.5% | 170 of 246 | 14 of 3012 (0.5%) | 94 of 3868 (2.4%) |
| 1.75 | 39.2% | 198 of 246 | 43 of 3012 (1.4%) | 189 of 3868 (4.9%) |

- AUC of the importance score for "stored anything": 0.869. 553 sessions stored something and 246 stored nothing.
- At 1.5, 58 of 553 yielding sessions would be skipped (10.5%, upper bound 13.3%), but they are thin ones: the median skipped-but-yielding session stored 0 decisions and 1 fact, only 12 held any decision, and only 9 held three or more items.
- This is consistent with the audit: sessions I audited as minor (importance 1) still stored an average of 2.4 decisions and 4.2 facts, so "stored anything" counts minor sessions as yielding. The measure overstates the loss.
- By runtime at 1.5: claude-code skips 19.8% (lost 9 of 1016 decisions, 86 of 1603 facts), muse skips 89% (80 of 81 stored-nothing sessions, nothing lost), hermes-agent skips 23% (5 of 241 decisions lost). Other runtimes had too few sessions to report.
- The stored output reflects whichever classifier model ran at the time, so it is a proxy for value, not ground truth.

Operationally, a false skip costs the extraction for that session, not the session: the body can still be indexed for recall, and a skipped session can be classified later.

## Conclusion

The gate works as a cost saver with a small, measurable loss. At threshold 1.5 it would have skipped 28.5% of classifier calls on a random sample while keeping 99.5% of stored decisions and 97.6% of stored facts, and on the audited sample it skipped none of 43 worthwhile sessions. On a backlog of about 1,240 files that is roughly 350 fewer classifier calls, around 6 hours of Gemma time at a minute each.

The gain is modest rather than large, and adoption needs a change inside the daemon's ingest step (flag-gated, fail-open, skipped sessions still stored), which is a separate plan.

## Other measurements from the same investigation

- Question types: `score` separated trivial from substantive sessions with a gap of 0.6 on a 0 to 3 scale, against 0.08 on 0 to 1 for `noul`. Spelling out the true and false cases in `noul` criteria added almost nothing.
- Batching: six questions in one call took 1.07 s, against 4.77 s as six calls. The state is read once.
- Truncation: Clef silently drops the tail of long state. A marker was found at 15k, 40k, 60k and 80k characters and missed at 100k and 120k. The 15k cap used by the classifier is well inside the safe range.
- Gemma's decision precision of 0.50 on the gold fixtures is mostly a reference-list artifact: 32 of its 51 reported decisions matched no reference but read as genuine decisions, and Clef accepted 31 of those 32. A decision filter would not improve it.
- H1 (recall-gate relevance filter) is demoted: per-prompt recall injection and the old gate are both off. A zero-shot spike on the 77-row gold kept 100% of informed rows at a 0.2 cutoff while skipping 17% of off-topic ones. Not pursued.

## Not yet run

H3 (Clef as the extraction judge) and H4 (session-close task status and capture triage) are specified in the plan and have no data yet.

## Next step

The daemon gate is built (T642, `docs/superpowers/plans/2026-10-13-clef-ingest-gate.md`) and tuned (T644, below). Settings in `~/.nlm/.env`: `NLM_INGEST_GATE` is `off` (default), `shadow` (score each session and append to `~/.nlm/clef-shadow.jsonl`, then classify as usual) or `live` (a session under the fitted threshold is stored with its adapter label, no extraction, `clef-gate` provenance and no workstream binding). Any Clef failure classifies the session normally. Read the shadow log with `npx tsx scripts/eval/clef-shadow.ts --report`.

## Gate tuning (2026-10-13, T644)

The importance score alone was weaker on live traffic than on history: on 300 live sessions its AUC for "stored anything" was 0.65, and skipping under 1.5 lost 2.1% of facts. Tuning keeps Clef frozen and changes what it is asked and how its answers are combined:

- `gateQuestions()` adds four questions aimed at what the classifier stores: `facts`, `outcome`, `delegated` (noul) and `extractable` (score), to the triage panel in one call.
- `gate-model.ts` turns the answers plus log session length into 17 features; a logistic model (`scripts/eval/clef-gate-fit.ts`, generated `gate-model-params.ts`) predicts P(stored anything). The threshold is the highest one that loses at most 0.5% of decisions and 2.5% of facts on the training half.
- Data: the 799 historical sessions, the 301 live shadow sessions and the 120 audited sessions, all answered by Clef (`scripts/eval/clef-gate-collect.ts`, cached under `~/.nlm/eval/gate-tune`). Trained on the tune half of historical plus live (541 sessions); reported on the held-out half and on the audited set.

| Set | Gate | AUC | Skipped | Decisions lost | Facts lost |
|---|---|---|---|---|---|
| Historical holdout (414) | fitted, P < 0.223 | 0.919 | 15.9% | 0.1% | 0.2% |
| | importance < 1.5 | 0.863 | 27.3% | 0.3% | 1.4% |
| Live holdout (146) | fitted | 0.714 | 4.8% | 0.0% | 0.5% |
| | importance < 1.5 | 0.683 | 8.2% | 0.0% | 2.2% |
| Audited (120) | fitted | 0.966 | 8.3% | 0.0% | 0.2% |
| | importance < 1.5 | 0.933 | 15.8% | 0.4% | 1.4% |

The fitted gate ranks better everywhere and loses far less, at the price of skipping fewer sessions; it skipped none of the 82 audited-worthwhile sessions. Live traffic stays the hard case (AUC 0.71, 4.8% skipped): recent sessions are longer agentic coding work, where almost everything yields a fact. The savings on live traffic are small, so the shadow week decides whether `live` is worth turning on. The wider panel costs time: serially about 2 s per session, 6 to 11 s for long ones, so the gate's Clef timeout is 30 s. If a larger cut is needed, the next step is retraining Clef's own decision head (`joint_head.safetensors`, about 128M parameters) on these labels; the backbone stays frozen.

## Workstream binding (2026-10-13, T640)

One Clef `choice` call per session (options: the 15 active workstreams by index, plus none) against the production namer (`tune-naming.ts`, `litellm-classifier`), on the 50-row matcher gold: 17 sessions that belong to a workstream, 33 that belong to none. Same session text and workstream list for both.

| | Correct binds (of 17) | Wrong binds | Correct abstains (of 33) | False binds | Time per session |
|---|---|---|---|---|---|
| Production namer | 13 | 0 | 32 | 1 | about 13 s (337 s total, 2 at a time) |
| Clef, cutoff 0 | 14 | 0 | 30 | 3 | median 9.9 s, min 4.3 s |
| Clef, cutoff 0.5 | 13 | 0 | 30 | 3 | |
| Clef, cutoff 0.7 | 12 | 0 | 31 | 2 | |
| Clef, cutoff 0.9 | 7 | 0 | 32 | 1 | |

Verdict: not adopted. The rule fixed before the run (more correct binds and no more wrong binds than the namer, abstains under half the rows) fails at every cutoff: where Clef binds more sessions it also false-binds more, and where it matches the namer's false binds it loses half the correct ones. Clef was not meaningfully faster here, because the Studio was serving other work during the run. With 17 positives the intervals are wide (Clef cutoff 0: 59 to 94%), so this is indicative only.

What this eval does not measure: in production, with scope stamping on, a name that matches no workstream creates a new one. This harness uses the unscoped path, so it scores missed binds as abstains. The namer's 4 missed binds may be new workstreams in production. That is a reason to look at workstream creation separately, not evidence for Clef.
