# Kickoff prompt — agent self-improvement signals build

Paste the block below into a fresh Claude Code session started in this repo
(`cd ~/Documents/Coding\ Projects/nlm-memory`) to build the feature designed in
[2026-06-09-agent-self-improvement-signals.md](./2026-06-09-agent-self-improvement-signals.md).

---

```
Build the "agent self-improvement signals" feature into NLM. Full design is approved
and written at:
  docs/superpowers/specs/2026-06-09-agent-self-improvement-signals.md

Read that spec first, then the existing seams it builds on (do NOT rebuild these):
  - src/ports/fact-store.ts + src/core/storage/{pg,sqlite}-fact-store.ts  (storage abstraction to mirror)
  - src/core/ingest/ingest-session.ts + src/core/adapters/*.ts            (ingestion; add nlm.signal recognition)
  - src/hook/prompt-recall-hook.ts + src/core/recall-facts/*              (the feedback hook — the piece that makes it self-improving)
  - src/llm/*-client.ts                                                    (own LLM, for pattern summarization)
  - src/ui/pages/Recall.tsx                                               (telemetry UI to extend)

Goal: capture structured quality/eval signals from any harness, aggregate them, and
recall "known failure modes for this repo/model" back into the agent's prompt at
session start. Make it portable — anyone running NLM gets it; any harness becomes a
producer with ~5 lines.

The portable contract is the `nlm.signal` event in the spec. Two transports: session-
embedded (custom session entry, ingested by the adapters) and HTTP POST /api/signal.

Reference producer (the first real emitter, in a DIFFERENT repo — wire it last as the
integration example, ~5 lines): the Pi quality-gate extension at
  ~/Documents/Coding Projects/pi-sandbox/extensions/quality-gate/index.ts
It currently writes interventions to /tmp/pi-quality-gate.log under PI_QUALITY_DEBUG;
that log line is exactly the signal to emit instead/also via appendEntry("nlm.signal", …).

Scope guardrails (v1):
  - Signals are a DISTINCT store kind, separate from semantic/conversational facts
    (structured, high-volume, no supersedence). Don't pollute the fact store's purpose.
  - The loop only "improves" if recall closes it — prioritize the prompt-recall block,
    not just a UI dashboard.
  - Surface + recommend; do NOT auto-act (no auto model-swapping) in v1.
  - Resolve the spec's open questions before coding the affected layer: signal retention/
    rollup-then-prune, recall trigger (always vs threshold), per-install privacy scoping,
    schema versioning.

Approach: brainstorm/plan before touching code, then build in layers (store → ingest +
HTTP route → aggregate → recall hook → UI → reference producer), each with tests. Follow
this repo's CLAUDE.md + session protocols (CHANGELOG entry before commit). Show me the
plan before implementing.
```

---

## Usage notes

- The prompt tells the new session to **resolve the four open questions before coding each
  affected layer** (retention policy, recall-trigger threshold, privacy scope, schema
  versioning). These are genuine design forks left open in the spec — the session should
  surface them to you, not guess.
- The reference producer patch lives in a **different repo** (`pi-sandbox`). The prompt flags
  it as the last step / integration example so the session doesn't start there.
- Source of this build: the Pi local-Qwen coding harness work (pi-sandbox commits `6b389ed`,
  `e9075e5`, 2026-06-09), where the quality gate's `/tmp` interventions were identified as
  signal worth capturing portably.
