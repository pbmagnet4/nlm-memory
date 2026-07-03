# Wave U1: Consumption Validation (#366, #389, #347) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Answer the campaign's scorecard claim 2 with numbers: do agents pull memory, and is what they pull useful? Ship the reliability hotfix (#389) that the measurement infrastructure depends on, make pulls attributable going forward, build the pull-usefulness instrument, measure, and land the contract/default-posture decisions on that data.

**Measured inputs (2026-07-03 scouts, load-bearing):**
- Pull volume survived the 06-23 pivot: 3.5 genuine pulls/day post vs 3.14 pre (33 session + 2 fact pulls in the 10-day window; fixture strip set reproduced the #366 baseline exactly). Volume is low absolute; quality unknown until judged.
- The MCP pull path logs NO conversation_id (handlers at src/mcp/server.ts:175-185, 419-429, 633-643, 687-697 omit it; the fact-log writer at src/core/recall-facts/fact-query-log.ts:56-68 lacks the field entirely). 0 of 3,851 mcp lines carry one. The pull-to-transcript join is impossible from the log; BUT transcripts record every MCP tool_use with its arguments, and pull queries are distinctive strings, so an instrument can join by transcript-side search. `returned_ids` IS logged on every line, so judged context is recoverable.
- #389 wedge mechanism: NOT event-loop starvation. Unbounded concurrent hybrid embeds each hold an inbound + outbound socket for up to the embed client's 30s abort (OpenAIEmbedderClient timeoutMs default 30_000 at src/llm/openai-embedder-client.ts:56, never overridden; Ollama 10s). macOS default FD soft limit 256; exhaustion starves accept() so health and keyword recall cannot get a socket. Therefore: the concurrency cap is the required fix for health; the deadline shrinks per-request hold and drains the tail. Both ship.

## Global Constraints

- PUBLIC repo: no internal hostnames, LAN IPs, home paths, client or unreleased-venture names in committed text. Eval scripts may read ~/.nlm and ~/.claude locally but never commit their outputs.
- No em dashes in added text. No literal NUL bytes. No new dependencies. No narration comments. Tests never touch ~/.nlm (temp dirs only).
- Gate per task: `npm run typecheck` + `npm test` green. Task 1 also `npm run test:pg` if it touches shared storage surfaces (it should not).
- Out of fence: `src/core/classifier/prompt.ts`, `src/llm/naming.ts`, `src/core/workstream/**`, daemon restart, corpus-scale writes to live canonical.
- src/ changes: `npm run build` + commit refreshed tracked plugin bundles in the same commit.
- Worktree `.worktrees/u1-consumption`, branch `feat/u1-consumption`; `git pull --rebase origin main` before merge; one implementer in the tree at a time.
- Measurement outputs go to `.superpowers/sdd/` (durable), never the session scratchpad.

## Pre-registered measurement frame (locked before results)

- Instrument reports usefulness@pull = (used + 0.5*partial)/n on the locked judge (scripts/eval/lib/usefulness-judge.ts), plus off-topic rate and per-runtime split, over ALL genuine pulls that join to a transcript (target n >= 30; genuine pull pool is ~127 all-time).
- This is a BASELINE measurement, not a ship gate. Scorecard target is >= 50%; whatever the number is, it gets published honestly and steers the contract iteration.
- Fixture strip set (shared constant in the instrument): session queries {"pgvector", "hono", "x", ""}; fact subjects {"nlm-memory-ts", "nle-memory-ts", ""}.

---

### Task 1: #389 embed deadline + in-flight cap (the hotfix)

**Files:** `src/ports/llm-client.ts` (embed signature gains optional opts), `src/llm/{ollama-client,openai-embedder-client,bundled-embedder-client}.ts`, `src/core/recall/recall-service.ts`, new `src/core/health/embed-inflight.ts`, `/api/health` handler, `tests/fixtures/llm-stubs.ts`, tests beside `tests/unit/core/recall-service.test.ts`.

**Pinned semantics:**
- Port: `embed(text, kind, opts?: { signal?: AbortSignal })`. Ollama + OpenAI clients race the external signal with their internal controller (abort internal fetch when the external signal fires); bundled client may ignore the signal (in-process, no socket). No other port methods change.
- New module `embed-inflight.ts` (mirror `src/core/health/embedding-lane-state.ts`: module singleton, `tryAcquire()/release()/inflightSnapshot()/resetForTests()`), cap from `NLM_RECALL_MAX_INFLIGHT_EMBEDS` (default 4, parseInt > 0 guard per `rewriteTimeoutMs` in src/llm/client-shared.ts:39-45).
- RecallService semantic leg (recall-service.ts:148-166): before embedding, `tryAcquire()`; on refusal set `semError = "ollama_unreachable"` (the EXISTING degradation contract at :159-171, zero new error codes) and skip the embed. On acquire, run the embed under an AbortController deadline (mirror the exemplar block at recall-service.ts:263-284: setTimeout aborts + rejects, clearTimeout and `release()` in finally). Deadline from `NLM_RECALL_EMBED_DEADLINE_MS`, default 2000, parseHookDeadline-style parsing (src/hook/prompt-recall-hook.ts:44-48).
- `/api/health` detail gains `embedInflight: { current, cap, shedTotal }` from the snapshot.
- StubEmbedder (tests/fixtures/llm-stubs.ts:12-25) gains a hang/delay option. Tests: timeout degrades hybrid to keyword with `modeUnavailable === "ollama_unreachable"` (slot beside tests/unit/core/recall-service.test.ts:160-177); cap: with N=cap hanging embeds in flight, request N+1 sheds to keyword WITHOUT entering the stub, and release restores capacity; abort actually fires the client-side signal.
- Commit: `fix(recall): deadline + in-flight cap on the semantic-leg embed (saturated embedder can no longer wedge the daemon)`

### Task 2: pull attribution (conversation_id on the MCP recall path)

**Files:** `src/mcp/server.ts` (four recall handlers), `src/core/recall-facts/fact-query-log.ts` (additive optional field), tests beside existing mcp/query-log tests.

- Resolution mechanism (AMENDED 2026-07-03 after reading the cite_session path): `resolveConversationForSession` (src/core/hook/memo.ts:72) reverse-looks-up which conversation was SHOWN a session id, which does not transfer to pulls (a pull has a query, not a session id). Instead: at handler time the calling runtime has already written the assistant tool_use containing the query string to its transcript, so resolve by scanning the N most-recently-modified transcripts under ~/.claude/projects (N=5, mtime-ordered) with a bounded tail read (reuse the 64KB tailRead pattern from src/hook/recent-context.ts) for the exact query string; first match wins; null otherwise. Deterministic under concurrent sessions (exact-match, not recency-guess), fail-open, and cheap enough for an explicit tool call (~tens of ms, not the per-prompt hot path). Non-Claude-Code runtimes resolve to null and stay unattributed, as today. New module `src/core/hook/resolve-conversation-by-query.ts` (or sibling in src/mcp/), wired into the recall_sessions / recall_code / recall_workstream / recall_facts handlers so `logQuery`/`logFactQuery` receive `conversationId` when resolvable; omit when not (writer already omits undefined, query-log.ts:58).
- `logFactQuery` writer + interface gain optional `conversation_id` (additive JSONL; existing readers tolerate extra fields; verify factRecallStats does).
- Tests: handler passes a resolvable conv id through; unresolvable stays absent; fact log line shape.
- Commit: `feat(mcp): recall pulls log the resolved conversation id (unblocks pull-usefulness measurement)`

### Task 3: pull-usefulness instrument

**Files:** new `scripts/eval/pull-usefulness.ts` (+ small shared helpers only if lifted verbatim from context-recall-ab.ts).

- Read both query logs, filter source=mcp, apply the pre-registered strip set, dedupe exact repeats.
- Join: for pulls WITH conversation_id (future data), locate transcript directly. For legacy pulls without one, search ~/.claude/projects/**/*.jsonl for a tool_use block of an nlm recall tool whose arguments contain the logged query string (cache the transcript list; the queries are long distinctive strings; skip ambiguous multi-hits).
- Response: assistant text AFTER the matched tool_use's result, until the next user turn, capped ~1500 chars (mirror hook-usefulness.ts responseAfterPrompt parsing, anchored at the tool result instead of a user turn).
- Context: top 3 of the pull's `returned_ids` resolved to label + summary + body[0:500] from `--db` (a VACUUM INTO snapshot; reuse the --db pattern and disposable-snapshot note from context-recall-ab.ts).
- Judge: `judgeUsefulness` from the locked lib, with the judge deadline-and-skip pattern from context-recall-ab.ts. Flags: `--days`, `--limit`, `--db`, `--model`, `--json`, `--verbose`. Report: n, joined-rate, usefulness@pull, offTopic, per-runtime and per-tool splits.
- Gate: `--limit=2` smoke runs end to end against a snapshot.
- Commit: `feat(eval): pull-usefulness instrument (judges whether agent pulls were actually used)`

### Task 4: measure + decide (controller-run)

- [ ] Snapshot canonical (VACUUM INTO under .superpowers/sdd/), run the instrument over the full genuine-pull pool, outputs to .superpowers/sdd/pull-usefulness-{result.json,run.log}.
- [ ] Read `scripts/eval/intent-distribution.ts` output for the same window (Phase 4 decision input rides along free).
- [ ] Write the verdict into the campaign scorecard row 2 (current number), #366 notes, and the ledger.
- [ ] Contract iteration proposal + shipped-default posture recommendation (ambient default vs pull-first contract for fresh installs; resolves #347 either way). BOTH go to Edward for sign-off before any product change ships; this plan ends at the recommendation.

### Task 5: reviews, merge, board, CHANGELOG

- [ ] Per-task Sonnet reviews; Opus whole-branch final review (Task 1 touches the hot serving path).
- [ ] Public scrub over the unpushed range; NUL/em-dash/narration sweep; merge, push, `gh run watch` green.
- [ ] Board: #389 -> Done with the FD-exhaustion root cause recorded; #366 updated with the measured numbers; #347 resolved per the posture decision (or annotated pending Edward). CHANGELOG entry.
