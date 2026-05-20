# NLM Auto-Inject Recall Hook — Design

**Status:** Approved design, ready for implementation planning
**Date:** 2026-05-20
**Tracking:** NLM open task #144
**Repo:** nlm-memory-ts

## Problem

NLM's write side works — the daemon ingests sessions automatically, the corpus is substantial, recall *coverage* is good (~92% hit rate). The unproven side is read adoption. The Recall page telemetry showed near-zero real agent recall traffic; fact recall had zero MCP calls ever. That number is confounded (the MCP server was broken until it was rewired on 2026-05-20), so adoption is untested rather than proven-bad — but the structural weakness is real regardless:

Read-side recall depends on the agent *deciding* a prompt is backward-looking and *choosing* to call the recall tool. That is a soft contract — a model judgment call on every prompt, with no guarantee. A memory system that is only read when the agent remembers to ask is not reliably a memory system.

This feature removes that dependency: relevant prior-session context is surfaced automatically, gated for relevance, via a Claude Code `UserPromptSubmit` hook.

## Scope

- **In scope:** A Claude Code `UserPromptSubmit` hook that surfaces relevant prior sessions automatically.
- **Out of scope (v1):** Hermes/Codex/Gemini equivalents (`UserPromptSubmit` is a Claude Code mechanism; other runtimes need their own integration — separate future work). Local-LLM relevance gating. Injecting full session content (v1 is pointer-only). Multi-machine sync.

## Design decisions

Four decisions were settled during brainstorming:

1. **Rollout posture: shadow mode first.** Build the full hook now; it evaluates every prompt and logs what it *would* surface, but injects nothing. After 1–2 weeks the relevance gate is tuned on real logged data, then a single flag flips it live. This resolves the task #144 wait-vs-build tension: the feature is built now and measured by the real artifact, and going live is a low-risk one-flag change.

2. **Relevance gate: heuristic prefilter + recall-score threshold.** No per-prompt LLM call. A cheap heuristic excludes obviously generative prompts; everything else queries recall and is gated on the top hit's score.

3. **Injection payload: pointer-only.** When the gate fires, inject a short pointer block (matched session ids + labels), not full content. The agent pulls detail with the existing `recall_sessions` / `get_session` MCP tools. Rationale: the structural problem is the agent never *realizing memory is relevant* — pointer-only fixes exactly that (surfaces awareness automatically) while leaving retrieval depth to the agent, at minimal token cost. If shadow/live data later shows agents see pointers but don't pull, escalating to compact content injection is a follow-up.

4. **Repeat control: per-conversation dedup memo.** Each relevant session is surfaced at most once per conversation. Chosen over a turn-based rate limit because (a) both approaches require per-conversation state, so the rate limit is not actually simpler; (b) the real waste is *redundancy* (re-surfacing the same session), which the memo eliminates and a rate limit only throttles; (c) a rate limit can suppress a genuinely new, highly relevant hit purely for timing reasons, which a memory feature should never do.

## Components

| Component | File | Responsibility |
|---|---|---|
| Gate (pure) | `src/core/hook/gate.ts` | `classifyPrompt(prompt) → "generative" \| "evaluate"`. Pure function, no I/O. Unit-tested. |
| Hook entrypoint | `src/hook/prompt-recall-hook.ts` → built to `dist/hook/prompt-recall-hook.js` | Invoked by Claude Code per prompt. Reads hook JSON from stdin, runs the gate, queries recall, injects (live) or logs (shadow). |
| CLI subcommand | `nlm hook install` / `nlm hook uninstall` (in `src/cli/nlm.ts`) | Adds/removes the `UserPromptSubmit` entry in `~/.claude/settings.json`. Idempotent and reversible. **Not** part of `nlm install`. |
| Shadow log | `~/.nlm/hook-log.jsonl` | Append-only. One line per prompt seen: timestamp, conversation id, truncated prompt, gate decision, recall hits + scores, would-inject flag, estimated token cost. |
| Per-conversation memo | `~/.nlm/hook-state/<conversation-id>.json` | The set of session ids already surfaced in this conversation. Drives dedup. |

## Gate logic

The heuristic is a **conservative generative *excluder***, not a backward-looking detector. The default classification is `evaluate`; only obviously generative prompts short-circuit to `generative`.

- `generative` signals (short-circuit, inject nothing, no API call): the prompt is dominated by generative intent — e.g. opens with or strongly centers on "write", "draft", "create", "compose", "brainstorm", "name", "generate", "design a", "come up with", "ideas for", "suggest a". The exact pattern set is seeded from the `workflows.md` recall trigger/non-trigger examples and refined against shadow-mode logs.
- `evaluate` (default — everything else): proceed to a recall query.

Rationale for the asymmetry: a false `evaluate` is cheap — recall returns weak hits and the score threshold discards them. A false `generative` (missing a backward-looking prompt) is the exact failure this feature exists to fix. So the heuristic is deliberately biased toward `evaluate`; the recall-score threshold does the real relevance filtering.

## Data flow (per prompt)

1. Claude Code fires `UserPromptSubmit` → runs `node dist/hook/prompt-recall-hook.js`, passing the hook payload as JSON on stdin (includes the user `prompt` and the conversation `session_id`).
2. The hook parses stdin and runs `classifyPrompt`.
   - `generative` → shadow: write a log line; live: nothing. Emit nothing. Exit 0.
   - `evaluate` → `GET http://localhost:3940/api/recall?q=<prompt>&mode=hybrid&limit=5` with header `x-recall-source: hook`.
3. Filter the returned hits to those with score ≥ the relevance threshold.
4. Load the per-conversation memo; drop hits whose session id was already surfaced.
5. Apply the per-conversation cap (see Token discipline).
6. Branch on mode:
   - **shadow** → append a log line (gate decision, surviving hits + scores, estimated token cost, would-inject flag). Emit nothing.
   - **live** → if any new hits remain, emit the pointer block to stdout and record those session ids in the memo. If none remain, emit nothing.
7. **Always exit 0.** Any error — daemon unreachable, malformed stdin, timeout — is caught and results in no output and a clean exit. The hook must never block or fail a prompt (fail open).

### Pointer block format (live mode)

```
## Possibly-relevant prior sessions (nlm-memory)
- sess_a1b2 · FTS5 vs pgvector decision (2026-05-15)
- sess_c3d4 · Semantic recall via sqlite-vec (2026-05-17)
Pull detail with the recall_sessions / get_session MCP tools if relevant.
```

## Token discipline

Context-bloat control is a first-class constraint, since the hook fires on every prompt.

- **Pointer-only payload.** ~3 lines. Hard cap of **3 sessions per fire**, target ≤ ~60 tokens. One terse line per session: `sess_id · label (date)`.
- **Each session surfaced at most once per conversation** (the dedup memo). `UserPromptSubmit` fires on every prompt; without dedup a long conversation would stack a pointer block every turn. The memo bounds total footprint by the count of *distinct relevant sessions*, not by conversation length.
- **Suppress empty fires.** If the gate passes but no hit clears the score threshold, or every surviving hit was already surfaced, inject nothing.
- **Per-conversation cap.** A hard ceiling of **10 distinct sessions surfaced per conversation**, total. A guardrail, not the primary mechanism — the memo plus the score threshold keep normal conversations well under it. Retained so a topic-roaming conversation cannot grow unbounded.
- **Score threshold** starts conservative and is tuned in shadow mode against the logged score distribution. Under-injecting is preferred to poisoning the well (a noisy gate trains the agent to ignore injected context).
- **Shadow log records estimated token cost per fire**, so the real per-conversation footprint is observed — not guessed — before going live.

Expected steady state: most prompts cost zero tokens (excluded by the gate, or no new hits). A conversation injects at most a handful of ~60-token pointer blocks total, each once.

## Mode flag

`NLM_HOOK_MODE` environment variable, read by the hook script. Default `shadow`. Values:

- `shadow` — evaluate, log, inject nothing.
- `live` — evaluate, log, inject pointer blocks.

The env var is set in the hook's command entry in `~/.claude/settings.json` (so `nlm hook install` writes it). Flipping to live after the review window is a one-line settings edit; a future `nlm hook enable` convenience subcommand is possible but out of scope for v1.

## Distribution

An explicit `nlm hook install` subcommand, **separate from `nlm install`**. Silently editing a user's `~/.claude/settings.json` during the main daemon install is too invasive. `nlm hook install`:

- Reads `~/.claude/settings.json` (creates it if absent).
- Adds a `UserPromptSubmit` hook entry pointing at the built hook script, with `NLM_HOOK_MODE=shadow` in its environment.
- Is idempotent — re-running does not duplicate the entry.

`nlm hook uninstall` removes exactly that entry and nothing else.

## Failure modes

| Condition | Behavior |
|---|---|
| Daemon down / `/api/recall` unreachable | Catch, emit nothing, exit 0. |
| Malformed or empty stdin | Catch, emit nothing, exit 0. |
| Recall query slow | Bounded by a short timeout (≈1s); on timeout, emit nothing, exit 0. |
| Memo file missing/corrupt | Treat as empty memo; continue. |
| `~/.claude/settings.json` malformed during `nlm hook install` | Abort with a clear error; do not write a broken file. |

The invariant: the hook never blocks, delays meaningfully, or fails a prompt. Every abnormal path is fail-open.

## Testing

- **`gate.ts`** — unit tests over a fixture set of generative vs retrospective prompts, seeded from the `workflows.md` recall trigger/non-trigger examples.
- **Hook script** — integration tests with a stubbed recall fetch: asserts shadow-mode logs and injects nothing; asserts live-mode injects the pointer block; asserts the dedup memo suppresses a repeat surfacing within one conversation; asserts fail-open on a simulated daemon-down.
- **`nlm hook install` / `uninstall`** — integration tests against a temp `settings.json`: install adds the entry and is idempotent on re-run; uninstall removes exactly its own entry and leaves the rest of the file intact.

## Open calibration items (resolved in shadow mode, not now)

- The exact generative-excluder pattern set.
- The recall-score threshold value.
- Whether the per-conversation cap of 10 is ever approached in practice.

These are intentionally left to empirical tuning against `~/.nlm/hook-log.jsonl` during the shadow window.
