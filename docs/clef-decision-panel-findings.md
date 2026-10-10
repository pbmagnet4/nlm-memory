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

## Other measurements from the same investigation

- Question types: `score` separated trivial from substantive sessions with a gap of 0.6 on a 0 to 3 scale, against 0.08 on 0 to 1 for `noul`. Spelling out the true and false cases in `noul` criteria added almost nothing.
- Batching: six questions in one call took 1.07 s, against 4.77 s as six calls. The state is read once.
- Truncation: Clef silently drops the tail of long state. A marker was found at 15k, 40k, 60k and 80k characters and missed at 100k and 120k. The 15k cap used by the classifier is well inside the safe range.
- Gemma's decision precision of 0.50 on the gold fixtures is mostly a reference-list artifact: 32 of its 51 reported decisions matched no reference but read as genuine decisions, and Clef accepted 31 of those 32. A decision filter would not improve it.
- H1 (recall-gate relevance filter) is demoted: per-prompt recall injection and the old gate are both off. A zero-shot spike on the 77-row gold kept 100% of informed rows at a 0.2 cutoff while skipping 17% of off-topic ones. Not pursued.

## Not yet run

H3 (Clef as the extraction judge) and H4 (session-close task status and capture triage) are specified in the plan and have no data yet.

## Next step

Shadow mode for H2: call Clef at ingest, log the decision beside the real classifier result, skip nothing, and review the log after a few hundred sessions. That adds labeled positives at no risk. An integration plan comes after that.
