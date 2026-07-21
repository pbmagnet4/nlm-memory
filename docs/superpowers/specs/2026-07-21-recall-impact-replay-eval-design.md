# Recall Impact Replay Eval — pre-registered design

**Status:** awaiting operator sign-off on the pre-registered bar. Date: 2026-07-21.
**Question:** does the context NLM injects into agent prompts causally improve the agent's response, on the operator's real workload?

This is the direct with/without experiment that replaces the passive proof strategy (citation accrual), which was measured structurally incapable (~1% peak capture, decaying to zero). The design and PASS/NULL bar are fixed BEFORE the run; the result stands either way. That is the point.

## Method

1. **Sample.** From `~/.nlm/hook-log.jsonl` `gate=evaluate` rows with non-empty `wouldInject`: n=100 pairs, fixed-seed sample (seed 20260721), stratified by month so no single week dominates. Exclusions, applied before sampling: prompts under 15 chars (bare continuations), prompts whose text already contains the injected content verbatim (leakage), duplicate prompts (keep first).
2. **Reconstruct arm A / arm B.** Arm A = the user prompt with the pointer block rebuilt from the row's `wouldInject` session ids via the same composer the hook uses. Arm B = the user prompt alone. If a referenced session no longer resolves, drop the row and draw a replacement from the same stratum (count reported).
3. **Generate.** One fixed local generator model (OpenAI-compatible endpoint, `NLM_EVAL_BASE_URL`), temperature 0.1, max_tokens 1024, identical settings both arms, sequential runs. Generator model recorded in the report. Known limitation, accepted: the generator approximates but is not the production agent; this biases the measurement DOWN for NLM (a weaker model exploits context less), so a PASS is conservative.
4. **Judge.** A different model family than the generator (never author=judge), blind: sees the user prompt and the two responses labeled X/Y with order randomized per pair (derived from the fixed seed), never sees which arm had injection and never sees the injected block itself. Three-way call per pair: X better / Y better / tie, judged on (a) specificity to the user's actual situation and history, (b) absence of generic filler, (c) actionability. One judgment per pair, plus a 20-pair double-judge subsample to report judge self-consistency.
5. **Metrics.**
   - `decisive_rate` = share of pairs judged non-tie.
   - `win_rate` = arm-A wins / decisive pairs.
   - Secondary (reported, not gating): win rate bucketed by injected-token count; win rate for fact-injection rows vs session-pointer rows.

## Pre-registered bar (the part that cannot move after the run)

- **PASS:** `win_rate >= 0.60` AND `decisive_rate >= 0.30`. Interpretation: injected recall visibly changes outcomes often enough to matter, and when it does, it helps decisively more than it hurts.
- **NULL:** anything below either threshold. Interpretation recorded verbatim in the wiki and NocoDB: "recall is cheap but unproven at changing outputs; effort shifts from building NLM to using NLM until evidence changes." No re-running with a different judge, sample, or bar to chase a PASS; a methodological flaw discovered post-run voids the run (documented), it does not license adjusting the bar.
- **HARM check (gating, either direction):** if arm B wins > 40% of decisive pairs, that is evidence injection actively hurts; treated as NULL plus a filed investigation task.

## Deliverables

- `scripts/eval/recall-impact-replay.ts` (sampling, reconstruction, generation, judging, report) + fixture-tested pure helpers.
- Report JSON to a durable path (`~/.nlm/eval-replay/…`) + a markdown summary; aggregates (n, rates, buckets, judge consistency, generator/judge identities, wall time) are committable; raw prompt/response text stays local (operator data, never committed).
- Result recorded in: NocoDB (new task tracking this eval), wiki learnings, and — if PASS — marketing-readiness (it becomes the first causal impact claim NLM can make publicly, with method).

## Out of scope

Latency impact, multi-turn effects, cross-runtime differences (single generator), and anything requiring new daemon code. This eval reads the hook log and the corpus read-only; it writes nothing to the live DB.
