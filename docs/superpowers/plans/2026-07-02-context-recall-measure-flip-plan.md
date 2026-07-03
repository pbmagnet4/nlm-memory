# Context-Recall Measurement and Default Flip (#357) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decide, on a trustworthy paired measurement, whether feeding recent conversation turns into the recall query fixes the measured off-topic problem (usefulness 18.2%, off-topic 81.8% on the locked judge), and if it clearly wins, ship it as the DEFAULT hook behavior so fresh installs get it without knowing the flag exists.

**What already exists (do not rebuild):** The mechanism shipped flag-gated OFF in PR #44: `buildRecallQuery` (src/hook/prompt-recall-hook.ts) prepends up to 3 recent transcript turns to the recall query when `NLM_HOOK_CONTEXT_RECALL=1`, ONLY for thin prompts (fewer than 3 topical words, the measured off-topic failure band), with bare-prompt fallback on every error path. The A/B gate harness shipped in PR #45 (scripts/eval/context-recall-ab.ts): it replays historical thin-prompt fires, runs recall both ways against the current corpus, and judges each arm's top hit against the agent's actual recorded response. The band filter shipped in PR #46 (hook-usefulness --band=thin). The 2026-06-22 A/B (29% to 54%) predates the locked judge (#360, validated 2026-06-23), so it does not count as the flip gate. Per the 2026-06-22 reckoning, only PAIRED deltas on the same judge are trustworthy.

**Why a default flip and not an env change:** The operator env already opted in (`NLM_HOOK_CONTEXT_RECALL=1` in the env file) and the operator's per-prompt lane is currently pull-mode anyway (`NLM_HOOK_PROMPT_RECALL=off`). The unshipped value is for fresh installs, where per-prompt recall defaults ON and queries the bare prompt. Shipping means flipping the code default so the flag becomes an opt-out.

**Latency case (why this is hook-budget safe):** the augmentation is a bounded 64KB tail read of the local transcript plus string assembly, no LLM call, and it runs only for thin prompts with a transcript path. The existing `NLM_HOOK_DEADLINE_MS` machinery and fail-open paths are untouched.

## Global Constraints

- This repo is PUBLIC. No internal hostnames, LAN IPs, home paths, client or unreleased-venture names in any committed text (localhost/127.0.0.1 fine).
- No em dashes in ANY added text. No literal NUL bytes. No new dependencies. No narration comments (WHY-comments only).
- Full gate after every code task: `npm run typecheck` clean + `npm test` green.
- Never commit anything under `.superpowers/`. Never commit eval JSON outputs with transcript content.
- OUT OF FENCE (a concurrent controller session owns these; a 2-day corpus reprocess is running): `src/core/classifier/prompt.ts`, `src/llm/naming.ts`, `src/core/workstream/**`, the user env file under `~/.nlm/`, `~/.nlm/reprocess.state`, any corpus-scale job against `~/.nlm/canonical.sqlite`, daemon restart. Read-only queries against the daemon and canonical.sqlite are fine.
- Judge lane is LOCAL ONLY: qwen3.5:4b via the Ollama instance on localhost:11434 (stood up for this wave; the controller reaps it at session end). No cloud API calls.
- If a task changes anything under `src/`, run `npm run build` and commit the refreshed plugin dist bundles in the same commit (CI has no bundle-sync guard yet).
- Work in a worktree under `.worktrees/` on branch `feat/context-recall-default`; one implementer in the tree at a time. Before any merge to main: `git pull --rebase origin main` (the other session pushes too).
- Commit style: `feat(hook): ...` / `fix(eval): ...`, one commit per task.

## Pre-registered decision rule (locked BEFORE looking at results)

Ship Task 3 only if ALL hold on the Task 2 A/B:
1. Scored sample n >= 30 paired fires.
2. Augmented usefulness beats bare by >= 10 percentage points.
3. Augmented off-topic (unused) rate is not worse than bare.

If the rule fails: do NOT ship Task 3; record the honest numbers in #357 and the CHANGELOG, leave the default OFF, and file what was learned.

---

### Task 1: align the A/B harness with the locked judge

**Files:**
- Modify: `scripts/eval/context-recall-ab.ts`

The harness currently inlines a pre-lock judge prompt and passes only `temperature: 0` (missing the pinned neutral sampling and the word-overlap clause). `lib/usefulness-judge.ts` exists precisely so bench and shipped judging cannot drift.

**Steps:**
- [ ] Replace the local `judge()` function and `Verdict` type with imports from `./lib/usefulness-judge.js` (`judgeUsefulness`, `USEFULNESS_MODEL`, `Verdict`). Default `--model` becomes `USEFULNESS_MODEL`.
- [ ] Call sites: `judge(args, prompt, ctx, resp)` becomes `judgeUsefulness(args.ollamaUrl, args.model, { prompt, context, response })`.
- [ ] No behavior change beyond the judge call. Keep `--limit/--days/--model/--ollama/--port/--verbose/--json` flags as they are.
- [ ] Gate: `npm run typecheck` clean; `npx tsx scripts/eval/context-recall-ab.ts --limit=1` runs end to end (daemon on :3940 and Ollama on :11434 are up).
- [ ] Commit: `fix(eval): context-recall A/B imports the locked usefulness judge`

### Task 2: paired measurement (controller-run, no code)

- [ ] Baseline for the record: `npx tsx scripts/eval/hook-usefulness.ts --band=thin --days=45 --limit=40 --json=<scratch>/usefulness-thin-baseline.json`
- [ ] The gate: `npx tsx scripts/eval/context-recall-ab.ts --limit=40 --days=45 --verbose --json=<scratch>/context-recall-ab.json`
- [ ] Sanity: confirm `augChangedTopHit > 0` (augmentation actually changes retrieval on a nontrivial share) and that scored n >= 30.
- [ ] Apply the pre-registered decision rule. Record numbers in the ledger.

### Task 3 (GATED on the rule passing): default-ON with opt-out

**Files:**
- Modify: `src/hook/prompt-recall-hook.ts` (`buildRecallQuery` flag check + doc comment)
- Modify: `tests/unit/hook/build-recall-query.test.ts`
- Modify: the hook env-var documentation wherever `NLM_HOOK_MODE` and friends are documented (grep README.md and docs/ for `NLM_HOOK_` and add/adjust the entry).

**Steps:**
- [ ] Write the failing tests first: context recall is ON by default (no env var set => thin prompt gets augmented); explicit `NLM_HOOK_CONTEXT_RECALL=0` and `off` disable it; `1` still enables it (back-compat with the operator env); specific prompts and missing-transcript fallbacks unchanged.
- [ ] Implement: the check `env["NLM_HOOK_CONTEXT_RECALL"] !== "1"` becomes an opt-out: disabled only when the value, trimmed and lowercased, is `"0"` or `"off"`. Update the function doc comment to describe default-on and cite the paired A/B result (numbers, date, judge) as the reason.
- [ ] Gate: `npm run typecheck` + `npm test` green.
- [ ] `npm run build`; commit refreshed plugin bundles in the same commit.
- [ ] Commit: `feat(hook): context-aware recall for thin prompts is now the default (measured win on the locked judge)`

### Task 4: reviews, merge, board + CHANGELOG sync

- [ ] Per-task Sonnet reviewer with the review-package script and this plan's constraints pasted in; controller reads every diff (NUL bytes, em dashes, narration comments, staged .superpowers files, public-repo scrub over the whole unpushed range).
- [ ] Merge `feat/context-recall-default` to main (`git pull --rebase origin main` first), push, `gh run watch` to green.
- [ ] Update #357 on the NLM board: measured numbers, decision, what shipped; set Status accordingly.
- [ ] CHANGELOG entry per session protocol (10-entry cap).
