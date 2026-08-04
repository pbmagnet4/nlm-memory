# Re-derivation detection: from a metric that cannot trend to an interrupt that fires

Date: 2026-08-03. Status: design, not yet planned into tasks beyond the board rows
referenced at the end.

## Why this

NLM's first success criterion, set at the product's founding and unchanged since,
is "re-derivation rate trending downward month over month." That is the thesis:
memory earns its keep by stopping you re-solving solved problems.

The machinery to measure it exists (`src/core/metrics/re-derivation.ts`, `nlm
metrics re-derivation`, a weekly trend file). It has never told anyone anything.
This spec explains why, and what to build instead.

The wider claim: re-derivation is a universal, expensive, completely uninstrumented
problem. Everyone using agents re-solves things constantly and nobody has a number
for it. There is no baseline, no benchmark, no tool. Producing that number requires
longitudinal cross-runtime capture with decisions extracted and links modeled,
which is the one thing NLM has and nothing else does. This is where "measurably
novel" actually lives.

## Evidence, measured 2026-08-03

Live 90-day run against the 8,673-session corpus:

- 7,452 sessions in window, 3,047 carrying at least one decision marker
- 15 pairs flagged, touching 22 unique sessions, of which 11 are the later
  ("re-deriving") side
- Reported rate: **0.00000787**, over a denominator of **1,905,166** entity-sharing
  session pairs

The weekly trend file, `~/.nlm/re-derivation-trend.jsonl`:

```
07-04  rate 0.0000083   pairs 4   eligible 479,571
07-12  rate 0.0000111   pairs 5   eligible 449,225
07-20  rate 0.0000100   pairs 6   eligible 602,737
07-27  rate 0.0000135   pairs 10  eligible 743,146
08-03  rate 0.0000113   pairs 9   eligible 799,190
```

Top pairs by Jaccard, with session labels resolved:

| Jaccard | A | B |
|---|---|---|
| 1.00 | 06-10 Updating default model to Sonnet 4.6 | 07-01 Updating default model setting |
| 1.00 | 06-24 Review of nlm-memory workstream filter implementation | 07-02 Review of Task 6 for nlm-memory |
| 0.84 | 05-17 Property validation skill specification | 05-24 Property Validate skill specification |

## Finding 1: the denominator makes the metric untrendable

`rate = pairs / entity-sharing session pairs`. That denominator grows
quadratically with corpus size. It went up 67% in a month (479k to 799k) while the
numerator moved 4 to 9. Any behavior signal is drowned by corpus growth, and the
rate mechanically falls the more the product is used, which is precisely backwards
for a metric whose job is to show improvement.

**Fix: make it session-level.** `rate = sessions that re-derive / sessions carrying
at least one decision`. Linear denominator, human-readable numerator, and a
sentence a person understands without a glossary.

Same data, both metrics:

| Metric | Value | Denominator |
|---|---|---|
| Current | 0.00000787 | 1,905,166 entity-sharing pairs |
| **Proposed** | **0.36%** | 3,047 decision-bearing sessions (11 re-deriving) |

Keep emitting the pair list; it is the useful artifact. Retire the pair-space rate
rather than reporting both, or the old number will keep getting quoted.

## Finding 2: 0.36% is not believable, and that is the real problem

A 0.36% re-derivation rate would mean roughly one session in 280 re-solves
something already settled. That does not match how anyone actually works, and it
does not match the three pairs above being found trivially in a hand scan.

The detector requires **all** of: at least one shared entity, decision-text Jaccard
at or above 0.5, more than `GAP_DAYS` apart, and no `continues`/`supersedes` edge.
That is a high-precision, low-recall configuration. The pairs it finds look real.
The pairs it misses are unknown and probably most of them, because Jaccard over
decision text only catches re-derivations that were worded similarly. A decision
re-made in different words is invisible.

**Precision looks good. Recall is unmeasured and probably poor.** Shipping an
interrupt on this detector as configured would produce something that almost never
fires.

This inverts the build order. The first task is not the metric and not the
interrupt. It is calibrating the detector against hand-labeled ground truth.

## Design

### Stage A: calibrate the detector (gates everything else)

Build a labeled set before touching thresholds. Sample candidate pairs across a
range of Jaccard values including below the current floor, plus entity-sharing
pairs the detector rejects, and hand-label each as genuine re-derivation or not.
Target something in the low hundreds of pairs, which is a sitting-down-for-an-
afternoon job, not a project.

Then report precision and recall at several threshold settings and pick from
measured curves rather than intuition. Expect the answer to be that the Jaccard
floor drops and a semantic-similarity leg gets added alongside word overlap.

This is the "validate the reference against ground truth once" rule from
`Operations/what-works`: testing a derived artifact against its own source cannot
fail. Right now the detector is only ever checked against itself.

### Stage B: fix the metric

Session-level rate per Finding 1. Backfill the trend file so history is
recomputed on the new denominator rather than leaving a discontinuity, and note
the recalibration date in the file. Surface the number and the pair list in the
daily digest, which is where operational signal already lives.

### Stage C: the in-flight interrupt

This is the product. Everything above is instrumentation for it.

When a live session's emerging decisions overlap a settled prior decision with no
link between them, say so **then**. The value of "you decided this on July 1" is
enormous at minute three of a session and roughly zero in a month-end report.

Everything needed already exists: decisions extracted per session, entity overlap,
supersedence edges to check against, and a recall path to fetch and surface the
prior session. The new part is running the comparison against the in-progress
session rather than only over closed ones.

Delivery surface is an open question (see below). Start with the pull path: an MCP
tool an agent can call, or a check folded into the existing recall response, before
touching the ambient hook lane.

### Stage D: prove it causally

Reuse the replay harness that produced the 0.881 result. Take real labeled
re-derivation pairs from Stage A, replay the later session with and without the
interrupt, and have a blind cross-family judge score whether the agent reached the
settled answer and how quickly. Pre-register the bar before running, as before.

That yields a causal claim about a capability that exists nowhere else, measured on
a real 14-month corpus, using methodology already validated in this repo.

## Sequencing

Stage A gates B, C, and D. Do not tune thresholds, ship an interrupt, or publish a
rate until the labeled set exists, because every one of those decisions depends on
recall numbers nobody currently has.

## Out of scope

- Cross-tenant or team-level re-derivation. Single-operator first; the tenancy
  substrate is there when it matters.
- Auto-linking sessions the detector believes are related. Detection and
  surfacing only. Writing `continues` edges automatically would corrupt the very
  signal the metric depends on.
- Any change to the ambient hook lane until the pull path is measured.

## Open questions

1. **Delivery surface for the interrupt.** MCP tool the agent calls, a field on
   the recall response, or ambient injection? Ambient reaches more cases and is
   also the lane that was silently dead for five weeks in May and June. Pull path
   first is the conservative call, but it only fires when an agent thinks to ask,
   which is exactly the failure mode the interrupt exists to catch.
2. **What counts as "settled."** Currently any decision marker. A decision that
   was itself superseded twice is weaker evidence than one that stood for months.
   Worth weighting, probably not in v1.
3. **False-positive cost.** An interrupt that cries wolf gets ignored, and unlike
   a metric, a wrong answer here is actively expensive to the operator's attention.
   Stage A's precision curve should set the firing threshold well above the
   metric's counting threshold. Those are two different numbers and should not be
   the same constant.
