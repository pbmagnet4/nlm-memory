# Phase 3: Consumer Contract and Zero-Cost Completion Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining gaps from the 2026-07-02 assessment: ship the consumer contract (`nlm init`) so fresh installs actually use recall well, finish the corpus upgrade and mid-tier measurement at zero API cost, instrument relational intent to settle the Phase 4 bet with data, and put the citation reranker on a promote-or-cut clock.

**Architecture:** Small additive surfaces only. `nlm init` emits agent-instruction snippets from shipped templates. A selection flag makes reprocess resumable across lane switches without re-burning upgraded sessions. Recall queries get a lightweight intent tag in the existing query log. No storage schema changes except one nullable column if intent logging needs it (prefer reusing the existing query-log JSONL).

**Tech Stack:** TypeScript ESM, Vitest. No new dependencies.

## Global Constraints

- **$0-first policy (standing, from operator direction 2026-07-02):** all bulk or background LLM work in this plan and its verification runs on local lanes only. The DeepSeek cloud API must not be called by any task, test, or verification step in this wave. Cost-bearing runs happen only with explicit operator approval, estimated cost stated first.
- This repo is PUBLIC. No internal hostnames, IPs, or non-public project names in committed text. Emitted templates are product content: generic voice, no operator-specific rules.
- No em dashes in ANY added text (self-check before commit: added lines contain zero U+2014). No literal NUL bytes (byte-check, and treat a Bin flag in git diffstat as a failed gate). No narration comments.
- Full gate after every task: `npm run typecheck` + `npm test`; pg-touching tasks also `npm run test:pg` (serial, NLM_PG_TEST_URL).
- Never commit anything under `.superpowers/`. `npm run build`; commit regenerated bundles if changed.
- Out of fence: `src/core/classifier/prompt.ts` (frozen), `src/llm/naming.ts`.
- Commit style: one commit per task.

---

### Task 1: Reprocess selection flags (--only-null, --exclude-model)

Small but blocking for the zero-cost corpus completion: today's selection treats "classifier_model != current lane" as eligible, so resuming the paused upgrade on a different (local) lane would re-select and downgrade the 143 sessions already stamped by the stronger cloud model.

**Files:**
- Modify: `src/core/ingest/reprocess.ts` (`selectReprocessCandidates` gains options `{ onlyNull?: boolean; excludeModels?: string[] }`), the reprocess command in `src/cli/nlm.ts` (`--only-null`, repeatable `--exclude-model <tag>`)
- Test: extend `tests/integration/reprocess.test.ts`

**Behavior contract:**
- `--only-null`: eligibility reduces to `classifier_model IS NULL` (plus the existing body predicate). The dry-run cohort report reflects the narrowed selection.
- `--exclude-model <tag>` (repeatable): removes sessions whose `classifier_model` equals any given tag from eligibility, composable with the default selection and with `--min-confidence`.
- Default behavior with neither flag: byte-identical to today.
- Help text documents the lane-switch use case in one sentence.

- [ ] **Step 1: Failing tests**: only-null selects exactly the NULL cohort; exclude-model removes stamped sessions; default unchanged; dry-run cohort respects both.
- [ ] **Step 2: RED, implement, full gate, commit:** `feat(extraction): reprocess selection flags for lane-switch resume (--only-null, --exclude-model)`

---

### Task 2: `nlm init` consumer contract

The biggest interop gap: the recall-behavior rules that make an agent use NLM well are hand-rolled in the author's workspace; fresh installs get nothing.

**Files:**
- Create: `templates/agent-contract/claude-code.md`, `templates/agent-contract/generic.md`, `templates/agent-contract/README.md`
- Modify: `src/cli/nlm.ts` (new `init` command), `package.json` ("templates" added to "files")
- Test: `tests/unit/cli/init-command.test.ts`

**Template content contract (product content, author carefully):**
- When to recall: questions referencing past work, prior decisions, unresolved questions ("what did we decide about X", "have we hit this bug before"). When NOT to: forward-looking drafting/brainstorming with no plausible prior context.
- How to recall: the pointer block arrives automatically via hooks; deliberate lookups use the MCP tools (recall_sessions for sessions, recall_facts for facts, get_session to read a full transcript worth reading).
- Citation behavior: cite a surfaced session (cite_session) only when it actually changed the answer or was read in full; never cite scanned-and-irrelevant results. One sentence on why: citations feed the precision metric and reranker.
- Trust boundaries: recall summaries are hints, not sources of truth; verify paths/IDs against the project's canonical config before acting on them.
- The claude-code variant formats this as a CLAUDE.md-ready section; generic variant is tool-agnostic prose for any agent instruction file.

**Command contract:**
- `nlm init --agent <claude-code|generic>` prints the snippet to stdout by default; `--write <path>` appends to the given file with a clearly delimited begin/end marker block (refuses if the markers already exist, so re-runs do not duplicate; `--force` replaces the marked block).
- Templates resolve like fixtures/migrations do (package-root relative, works from src and dist).

- [ ] **Step 1: Author templates first** (they are the deliverable), then failing tests: stdout emission per agent flag, --write appends with markers, re-run refuses without --force, --force replaces in place, unknown agent errors.
- [ ] **Step 2: RED, implement, full gate, commit:** `feat(consumer): nlm init emits the agent recall contract`

---

### Task 3: Recall-query intent instrumentation

Settles the Phase 4 relational-recall bet with data instead of speculation.

**Files:**
- Modify: the recall query-log write path (find where /api/recall and MCP recall log queries today; extend the JSONL record with an `intent` field), plus a small pure classifier `src/core/recall/query-intent.ts`
- Test: unit tests on the intent heuristic + one integration assertion that the log line carries the field

**Behavior contract:**
- `classifyQueryIntent(query): "lookup" | "relational" | "temporal" | "other"` as a pure heuristic (no LLM): relational = patterns like "depends on", "related to", "connected", "what uses", "downstream of"; temporal = the existing temporal query-shape detector's vocabulary (reuse `detectQueryShape` if it already exposes this); lookup = default for entity/keyword queries.
- Zero behavior change to recall itself; the field is write-only telemetry into the existing log.
- A tiny report command or script (`scripts/eval/intent-distribution.ts` following the tracked-script conventions) prints the distribution from the log so the Phase 4 decision reads from one number.

- [ ] **Step 1: Failing tests, RED, implement, full gate, commit:** `feat(recall): query intent telemetry for the relational-recall decision`

---

### Task 4: Correct citation-value claims at their source (RESCOPED 2026-07-03)

Original scope (a promote-or-cut decision harness) is redundant: the decision was already made by the 2026-06 ablation (`scripts/eval/reranker-ablation.ts`, `docs/reranker-ablation-findings.md`): citation-frequency reranking is net-negative at every weight (R@1 -2.6pp at alpha 0.15) and is permanently bypassed in recall-service.ts, with buildCitationBoosts retained deliberately as a harness hook. No new harness needed. What remains is that shipped surfaces still CLAIM citations train a reranker.

**Files:**
- Modify: `src/mcp/server.ts` (~line 452, CITE_SESSION_DESCRIPTION claims "training a per-operator reranker over time"; replace with the true value: citations feed the recall precision metric)
- Sweep: `grep -rni "reranker" docs/ templates/ src/mcp/ src/http/` and fix any other surface claiming citations improve ranking today; the ablation findings doc itself and the harness utilities stay as-is (they are accurate history)
- Test: if any test pins the old description text, update it

- [ ] **Step 1: Sweep, fix, full gate, commit:** `fix(mcp): cite_session description matches the ablation reality (precision metric, not reranker training)`

---

## Operational runbook (not code tasks; operator-approved actions)

These run outside the wave, all at $0:

1. **Mid-tier baseline:** when the Studio 27B endpoint is up, `NLM_CLASSIFIER=openai NLM_CLASSIFIER_BASE_URL=<studio> NLM_CLASSIFIER_MODEL=<tag from /v1/models> nlm eval --classifier --json`; fill the mid row in docs/classifier-tiers.md from the result.
2. **Corpus completion:** if the mid-tier numbers land materially above floor, resume the upgrade with `nlm reprocess --only-null` (Task 1's flag) on the Studio lane. 5,161 sessions at local speed, zero spend, resumable. The 143 cloud-stamped sessions stay untouched.
3. **Precision watch:** after two weeks of accumulation, run the Task 4 report and make the promote-or-cut call; check `nlm precision` trend for the upgrade's effect.
4. **work-digest verification** for the workstream bind flip (already scheduled).

## Out of scope

- pg reprocess variant (board task 388; unblocked, independent).
- Full temporal KG (waits on Task 3's distribution data).
- Any DeepSeek API usage.
