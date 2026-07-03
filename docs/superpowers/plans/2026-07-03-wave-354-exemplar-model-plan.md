# Wave #354: Exemplar Model Provenance (fix, scoped) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Execute the #354 fix-or-fence decision as FIX, scoped to the one truthfully-fixable field: thread the model name from the Claude Code transcript through SessionChunk into session-ingest exemplar capture, so new exemplars stop defaulting to model=unknown.

**Architecture:** One optional field on the SessionChunk port, populated by the claude-code adapter from assistant-turn metadata, passed through capture-from-session into extractFromGitSha. No schema change (the column exists), no new modules.

**Decision record (2026-07-03, controller, delegated by mission grant):**
- FIX scoped to model. Audit facts (scout, live DB read-only): 348 exemplars, 340 via session ingest all model=unknown; 6 of 8 signal-path exemplars carry a real model. The JSONL source data carries `model` on assistant turns; the adapter simply never surfaced it.
- outcome needs NO fix: outcome=pass is definitionally truthful for commit-capture (a committed diff is accepted code); the signal path (Path B) already writes fail on nonzero test exit.
- survived stays deferred WITH TRIGGER: no writer exists anywhere (grep-verified); building revert detection is a new background feature, out of a day-wave. Its consumer (pruneReverted, retention Stage A+B) is live and fires the moment any row gets survived=0. Trigger to build the writer: when exemplar recall usage is measured non-trivial (#346's ablation) or reverted-code pollution is observed in recall_code output.
- Legacy 340 rows stay unknown: model is not persisted on the sessions table, so no truthful backfill exists. Documented, not papered over.

## Global Constraints

- PUBLIC repo: no internal hostnames, LAN IPs (localhost/127.0.0.1 fine), home paths, client or unreleased-venture names in committed text.
- No em dashes in added text. No literal NUL bytes. No narration comments (WHY-comments only). No new dependencies.
- Tests never touch ~/.nlm (temp dirs and fixture JSONL only).
- Gate per task: `npm run typecheck` + `npm test` green.
- src/ changes: `npm run build` and commit refreshed tracked bundles (plugin/scripts/*.mjs, nlm/index.js) in the SAME commit if they change.
- Out of fence: `src/core/classifier/prompt.ts` (FROZEN), `src/llm/naming.ts`, `src/core/workstream/**`, daemon restart, ~/.nlm/.env, corpus-scale writes to live canonical.
- Worktree `.worktrees/354-exemplar-model`, branch `feat/354-exemplar-model`; `git pull --rebase origin main` before merge; one writer in the tree at a time.

## Pinned semantics

- `SessionChunk` (src/ports/transcript-adapter.ts) gains `readonly model?: string`. Optional: adapters that cannot know the model omit it and capture keeps writing "unknown" (truthful).
- Claude Code adapter (src/core/adapters/claude-code.ts): while parsing a chunk's messages, record the `model` string found on assistant-turn metadata; the chunk's model is the LAST assistant model seen in that chunk. Granularity is chunk-level provenance and the docs say so. Missing/empty model fields leave the chunk model unset.
- capture-from-session (src/core/exemplars/capture-from-session.ts): pass `chunk.model` into the extract call so `extractFromGitSha` receives `model: chunk.model` (its existing `params.model ?? "unknown"` default at src/core/exemplars/extract-exemplar.ts:74 handles absence).
- Path B (code-signal) is untouched: it already passes a real model when the caller supplies one.
- No other SessionChunk producer changes in this wave; codex/hermes/pi adapters omitting model is truthful.

---

### Task 1: thread model through SessionChunk into exemplar capture

**Files:**
- Modify: `src/ports/transcript-adapter.ts` (SessionChunk interface)
- Modify: `src/core/adapters/claude-code.ts` (surface assistant-turn model)
- Modify: `src/core/exemplars/capture-from-session.ts` (pass chunk.model through)
- Test: extend the existing suites beside `tests/unit/core/adapters/claude-code.test.ts` (or the actual current path found by `ls tests/unit/core/adapters/`) and `tests/unit/core/exemplars/capture-from-session.test.ts` (same rule)
- Docs: `docs/code-signal.md` provenance note (chunk-level model granularity; legacy rows stay unknown; survived deferred with pruneReverted wired)

**Interfaces:**
- Produces: `SessionChunk.model?: string`; exemplars created by session ingest carry the transcript's chunk-level model string.

- [ ] **Step 1: failing test, adapter surfaces model**

In the claude-code adapter test suite, add a fixture JSONL where two assistant turns carry `"model": "claude-sonnet-4-6"` then `"model": "claude-opus-4-8"` (whatever key path the adapter's parsed message shape actually uses; read the adapter first and mirror the real JSONL field, which on Claude Code assistant events is `message.model`). Assert the produced chunk has `model === "claude-opus-4-8"` (last assistant model wins). Add a second case: no assistant model fields, chunk `model` is `undefined`.

- [ ] **Step 2: run to verify it fails** (`npx vitest run <that suite>`)

- [ ] **Step 3: implement adapter + port change minimally**

Add `readonly model?: string` to SessionChunk. In the claude-code adapter's message walk, keep a `lastModel: string | undefined`, set from each assistant event's model field when it is a non-empty string, and attach to the emitted chunk (spread-style `...(lastModel ? { model: lastModel } : {})` to keep exactOptionalPropertyTypes happy if the codebase uses it).

- [ ] **Step 4: failing test, capture passes model through**

In the capture-from-session suite, the existing tests build chunks and a fake extract dependency; add a case where the chunk carries `model: "m-test"` and assert the created exemplar (or the extract call) received `model: "m-test"`, and a companion case with no model asserting the stored exemplar has `model: "unknown"` (the extract default, unchanged).

- [ ] **Step 5: implement the pass-through, run the two suites, then the full gate**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 6: docs note**

In `docs/code-signal.md` (the exemplar lane doc), add a short "Provenance" subsection: session-ingest exemplars carry chunk-level model provenance from the transcript (last assistant model in the chunk) as of #354; exemplars captured before this carry model=unknown and cannot be truthfully backfilled; outcome=pass is definitional for commit-capture and real failures enter via `nlm code-signal`; survived remains unwritten by design, pruneReverted is wired and idle until a revert-detection writer exists.

- [ ] **Step 7: build + commit (one commit)**

```bash
npm run build
git add src/ports/transcript-adapter.ts src/core/adapters/claude-code.ts src/core/exemplars/capture-from-session.ts tests docs/code-signal.md plugin/scripts nlm/index.js
git commit -m "feat(exemplars): session-ingest exemplars carry chunk-level model provenance (#354)"
```

Include refreshed tracked bundles only if the build actually changed them; verify with `git show --stat HEAD`.

### Task 2 (controller): review, merge, board

- [ ] Sonnet task review; controller diff read + python byte-checks; this wave touches src/ so it gets the Opus whole-branch final review before merge.
- [ ] Public scrub; `git pull --rebase origin main`; merge; push; CI watch with run-identity verification.
- [ ] Board: #354 -> Done with the full decision rationale (FIX scoped to model; outcome already truthful; survived deferred with trigger; legacy rows documented). #337 and #346 get dated notes: lane NOT fenced, stays on; both remain parked with the concrete trigger "exemplar corpus accumulates model-known rows (n>=100) or a survived writer ships". CHANGELOG entry rides with the wave.
