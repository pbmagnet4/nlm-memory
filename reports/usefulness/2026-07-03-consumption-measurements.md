# Consumption Measurements, 2026-07-03

Aggregate usefulness scores for the nlm-memory recall instruments. All numbers
produced by the locked usefulness judge (model `qwen3.5:4b`,
`scripts/eval/lib/usefulness-judge.ts`). Raw scoring artifacts are local eval
outputs and are not committed; the aggregates restated here are the citable
record.

Pre-registration reference: `docs/superpowers/plans/2026-07-03-wave-u1-consumption-plan.md`.

---

## 1. Ambient per-prompt injection (hook-usefulness instrument)

Measures whether context injected automatically on every Claude Code prompt is
used in the assistant response that immediately follows.

| Metric | Value |
|---|---|
| Usefulness | 18.2% |
| Off-topic | 81.8% |

The ambient path injects context before the agent has declared any information
need. Most turns have no information gap the recalled context could fill, which
explains the high off-topic rate.

---

## 2. Thin-prompt band (hook-usefulness --band=thin, days=45)

Restricts scoring to prompts below a length threshold ("thin" prompts), which
are more likely to carry a genuine information need.

| Metric | Value |
|---|---|
| n scored | 19 |
| Usefulness | 7.9% |
| Off-topic | 89.5% |
| Cited | 0% |

Thin prompts did not improve usefulness over the ambient baseline. The recall
context retrieved for very short queries does not match the agent's actual
information need in this window.

---

## 3. Context-augmentation A/B (context-recall-ab, n=40 paired thin fires)

Paired comparison: the same thin-prompt fires scored once with bare recall
output and once with augmented context (richer session body included).

| Condition | Usefulness | Off-topic |
|---|---|---|
| Bare | 28.7% | 67.5% |
| Augmented | 31.3% | 57.5% |
| Delta | +2.5 pts | |

**Pre-registered ship gate: +10 pts delta.** Observed delta is +2.5 pts.
**Decision: NOT SHIPPED.**

This negative result is part of the measurement record. Richer context
marginally improves usefulness but does not clear the pre-registered threshold.
The pre-registration is in `docs/superpowers/plans/2026-07-03-wave-u1-consumption-plan.md`
(locked before results were observed).

---

## 4. Pull path (pull-usefulness, run date 2026-07-03)

Scores explicit agent pulls -- cases where the agent issued a recall tool call
(`recall_sessions`, `recall_facts`, `recall_code`, `recall_workstream`) rather
than receiving injected context passively.

| Metric | Value |
|---|---|
| Raw pulls (mcp source) | 3,920 |
| Genuine after strip set | 195 |
| Joined to transcripts and scored | 78 |
| usefulness@pull | 72.4% |
| Off-topic | 21.8% |
| Used (verdict) | 52 |
| Partial (verdict) | 9 |
| Unused (verdict) | 17 |

Split by tool:

| Tool | usefulness@pull |
|---|---|
| Session pulls | 66.7% |
| Fact pulls | 88.1% |

The pull path significantly outperforms the ambient injection path (72.4% vs
18.2%), which is the primary evidence supporting the pull-first posture decision.
Fact pulls score higher than session pulls, consistent with fact recall
returning more targeted context.

---

## 5. Intent distribution (14-day window, n=640)

Classifies pull queries by intent to guide knowledge-graph investment decisions.

| Intent class | Share |
|---|---|
| Lookup | 99.1% |
| Relational | 0.9% |
| Temporal | 0% |

**Decision:** Temporal intent is absent in the observed window. The temporal
knowledge graph was not built. Telemetry stays on to detect if temporal intent
emerges as usage grows.

---

## 6. Consequence shipped

Based on these measurements:

- **Pull-first posture** shipped (board task #392): fresh installs default to pull-on-demand
  rather than ambient per-prompt injection.
- **Per-prompt ambient recall off on fresh installs:** the ambient hook is
  disabled by default; agents must issue an explicit recall tool call to retrieve
  context.

---

## Method notes

**What "genuine pull" means.** The fixture strip set filters out known test
queries and empty strings before scoring. Pre-registered strip set constants
(locked 2026-07-03):

- Session query strip set: `{"pgvector", "hono", "x", ""}`.
- Fact subject strip set: `{"nlm-memory-ts", "nle-memory-ts", ""}`.

**What the judge sees.** For each scored pull the judge receives: (1) the
original query string as the user prompt, (2) the top 3 returned session or
fact records (label + summary + first 500 chars of body) as injected context,
(3) the assistant text that immediately followed the tool result in the
transcript, capped at 1,500 chars.

**Why the join rate is approximately 40%.** The mcp recall path did not log
`conversation_id` at the time most of these pulls were recorded (handlers in
`src/mcp/server.ts` and `src/core/recall-facts/fact-query-log.ts` lacked the
field). Legacy pulls are joined by scanning transcripts for the exact query
string inside an nlm recall `tool_use` block. Ambiguous multi-transcript matches
are discarded (fail-safe: a wrong join is worse than a dropped one). Pulls with queries shorter than 12 characters cannot
be searched reliably and are also dropped. The combination of these factors
produces the observed join rate.

**Scoring formula.** `usefulness@pull = (used + 0.5 * partial) / n`. Off-topic
rate = `unused / n`. The judge's reliable signal is binary (informed vs
off-topic); the used-vs-partial split carries inherent noise (see judge
validation notes in `scripts/eval/lib/usefulness-judge.ts`: 75% exact 3-way
agreement, 86% binary, 96% specificity on the gold set).

**Raw artifacts.** Scoring outputs (per-pull verdict rows, run logs) are local
eval artifacts under `.superpowers/sdd/` and are not committed to the public
repo. The aggregates restated in this file are the authoritative citable record.
