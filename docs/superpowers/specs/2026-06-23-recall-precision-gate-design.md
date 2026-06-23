# Recall-precision gate — scoping + design (option A)

Status: **awaiting sign-off** (Tier 2 — changes hot-path behavior + adds latency).
Companion to the usefulness-judge keystone (NocoDB #360).

## Problem

Passive session-matching recall injects the top-scoring prior session into the
agent's context on every fire that clears the content gate. Measured on the
locked usefulness judge: **~80% of those injections are off-topic** (the agent
never uses them). That is wasted tokens and distraction on most turns.

## Why the cheap levers don't work (evidence, not assertion)

- **Per-session frequency cap** — refuted. Over-recalled "magnet" sessions are
  no more off-topic than ordinary ones (84% vs 80%, `magnet-usefulness.ts`).
- **Relevance threshold on the recall score** — refuted. Off-topic fires score
  *higher* than informed (27.6 vs 20.9); off-topic rate is flat-to-inverse
  across score quartiles (`offtopic-score.ts`). The score is uninformative for
  usefulness.

The recall score carries no usefulness signal, so precision needs a *new*
signal. An LLM relevance judgment is that signal.

## The gate

Before injecting a candidate, ask a small local model: *given the prompt and the
candidate context (no response yet), is this likely to help?* Skip on a
confident "irrelevant".

### Feasibility — measured on the frontier gold (`gate-feasibility.ts`, n=77)

The gate has real, independent signal. Operating points (qwen3.5:4b):

| mode | informed kept | off-topic skipped | injected precision | volume kept |
|------|---------------|-------------------|--------------------|-------------|
| balanced     | 67% (drops 8/24) | 60% | 31%→43% | 48% |
| conservative | **96% (drops 1/24)** | 25% | 31%→37% | 82% |

**Recommended operating point: conservative.** The asymmetry is the whole point —
dropping a useful injection forfeits memory's signature value (surfacing what the
agent wouldn't ask for), while keeping a marginal one only costs tokens. At 96%
informed-retention the gate still removes ~25% of off-topic and ~18% of total
injection volume.

### Honest expected impact

A **modest, safe** win, not a fix: ~25% less off-topic noise, ~18% fewer
injected tokens, ≥96% of useful injections retained. Off-topic stays ~63% after
the gate. It kills the clearly-cross-topic cases (the worst distractors); it does
not rescue same-project-but-unused injections.

## Design

1. **Shadow mode first.** Log `gateDecision` (relevant/irrelevant) into the
   hook-log alongside the existing fire record, but DO NOT skip yet. Run for a
   few days, then re-run `gate-feasibility`-style analysis on real fires (not
   just gold) to confirm the gold operating point holds live. Only then flip to
   live skipping.
2. **Flag-gated + reversible**, mirroring `NLM_HOOK_CONTEXT_RECALL`: e.g.
   `NLM_HOOK_RECALL_GATE=shadow|live|off`, toggled via `~/.nlm/.env`.
3. **Placement.** In the hook, after candidates are scored and the content gate
   passes, before emitting `wouldInject`. Gate each candidate the conservative
   prompt; drop the confidently-irrelevant ones; inject what survives (still
   capped at top-k).
4. **Judge reuse.** Same model + sampling as the locked usefulness judge
   (`lib/usefulness-judge.ts`), different prompt (the gate prompt predicts
   relevance pre-response). Keep the gate prompt in the shared lib so it's
   versioned with the judge.
5. **Latency budget.** ~1.2s/candidate on the hot path. Mitigations, in order:
   (a) only gate the candidate(s) actually about to be injected (top-k, usually
   1–3), not the whole hit list; (b) cache by `(promptHash, candidateId)` —
   re-fires on the same prompt/candidate are free; (c) if still too slow, try a
   smaller/faster local model for the gate only (it's a binary call). Measure
   real added latency in shadow mode before committing.

## Risks / open questions

- **Latency on the hot path.** The hard constraint. Shadow mode measures it; if
  the added wall-clock per turn is unacceptable even after caching, A is not
  viable and we fall back to option B (demote passive injection → context-recall
  + on-demand retrieval).
- **Gold is small (24 informed / 53 off-topic).** One dropped useful = ~4% recall
  swing. The live shadow-mode pass is the real validation; the gold is the
  go/no-go screen, which it passed.
- **Operating point may drift live** vs the gold sample — hence shadow first.
- **Portability** (it's a client-deployable product): the gate model must be a
  small local model a stranger can run (qwen3.5:4b qualifies). No cloud
  dependency on the hot path.

## Decision needed

Approve building this in **shadow mode** (log-only, zero behavior change, lets us
measure live precision + latency), with the live flip gated on that data? Or,
given the modest measured ceiling, deprioritize A in favor of option B?
