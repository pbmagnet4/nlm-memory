# Wave #392: Pull-First Default + Contract Iteration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Ship the Edward-approved pull-first posture: fresh installs default per-prompt ambient recall OFF, the recall-contract templates gain explicit pull triggers so pull frequency rises, and every user-facing surface (setup output, README, docs/hooks.md) describes the posture truthfully.

**Architecture:** One boolean default flip in the hook entry gate (zero hot-path work when disabled, already shipped as opt-in Option B), plus copy revisions across the contract templates and docs. No new modules, no new dependencies.

**Measured inputs (U1, 2026-07-03, load-bearing):**
- usefulness@pull 72.4% (n=78, locked judge; fact pulls 88.1%) vs ambient injection 18.2% (hook-usefulness) / 7.9% (thin band). Pulls are ~4x more useful than ambient injection on the same judge.
- Pull volume is the gap: 3.5 genuine pulls/day. The contract templates never tell the agent WHEN to pull beyond history-flavored phrasing; the four missing trigger classes are task start, before re-deriving a prior decision, unfamiliar project/entity mentions, post-compaction.
- Decision GRANTED 2026-07-03 (recorded on board #392): pull-first is the shipped fresh-install posture. The session-start passive layer (once per session, cheap, unmeasured-negative) STAYS ON.

## Global Constraints

- PUBLIC repo: no internal hostnames, LAN IPs (localhost/127.0.0.1 fine), home paths, client or unreleased-venture names in committed text.
- No em dashes in added text. No literal NUL bytes. No narration comments (WHY-comments only). No new dependencies.
- Tests never touch ~/.nlm (env objects passed explicitly).
- Gate per task: `npm run typecheck` + `npm test` green.
- src/ changes: `npm run build` (build:server + build:ui + build:codex-plugin) and commit the refreshed tracked `plugin/scripts/*.mjs` bundles in the SAME commit as the src change.
- Out of fence: `src/core/classifier/prompt.ts` (FROZEN), `src/llm/naming.ts`, `src/core/workstream/**`, daemon restart, ~/.nlm/.env.
- Worktree `.worktrees/392-pull-first`, branch `feat/392-pull-first`; `git pull --rebase origin main` before merge; one writer in the tree at a time.

## Pinned semantics (the flip)

`promptRecallEnabled(env)` in `src/hook/prompt-recall-hook.ts:83-85` becomes:

- Var UNSET or empty after trim: **false** (the new fresh-install default: pull-first).
- Var set to `off` (case-insensitive, trimmed): false (unchanged).
- Var set to ANY other non-empty value (`on`, and legacy opt-ins like `live` or `1`): **true**. Existing installs that already set the var keep exactly their current behavior; `on` is the documented opt-in spelling.
- The ONLY call site is the per-prompt entry gate (prompt-recall-hook.ts:261). The session-start hook (`src/hook/session-start-hook.ts`) does not consult this flag and MUST NOT gain a dependency on it.
- The doc comment above the function is rewritten to describe pull-first as the default WITH the measurement that justified it (72.4% vs 18.2%/7.9%); it currently describes default-on Option B opt-out semantics, which becomes false with this change.

## Contract copy direction (pinned)

Both templates (`templates/agent-contract/claude-code.md`, `templates/agent-contract/generic.md`) gain a pull-triggers list and stop implying every prompt gets ambient injection:

- "When to recall" adds four explicit trigger classes ABOVE the existing history-question examples: (1) at task start, pull for prior context on the task's subject before starting work; (2) before re-deriving anything that smells like a prior decision, check whether it was already decided; (3) when the user mentions a project, system, or entity you do not recognize from the current conversation; (4) after context compaction or summarization, re-pull what the summary dropped.
- The "pointer block" section is rewritten: the pointer block arrives once at session start (and the contract must not promise per-prompt injection); mid-conversation memory access is the agent's job via the recall tools.
- The existing skip guidance (greenfield/forward-looking prompts) stays.
- Tone and formatting follow each template's existing register (claude-code.md uses ### sections and bold tool bullets; generic.md uses ## sections and prose).

---

### Task 1: the default flip

**Files:**
- Modify: `src/hook/prompt-recall-hook.ts:71-85` (doc comment + `promptRecallEnabled`)
- Modify: `tests/integration/prompt-recall-hook.test.ts:202-222` (the `promptRecallEnabled` describe block)
- Commit alongside: refreshed `plugin/scripts/*.mjs` from `npm run build`

**Interfaces:**
- Produces: `promptRecallEnabled(env?): boolean` with the pinned semantics above (signature unchanged; only the unset/empty default flips).

- [ ] **Step 1: update the tests to the pinned semantics (they will fail against current code)**

Replace the body of the `describe("promptRecallEnabled", ...)` block so it asserts:

```ts
describe("promptRecallEnabled", () => {
  it("defaults OFF when the var is unset (pull-first posture)", () => {
    expect(promptRecallEnabled({})).toBe(false);
  });

  it("treats empty and whitespace-only values as unset", () => {
    expect(promptRecallEnabled({ NLM_HOOK_PROMPT_RECALL: "" })).toBe(false);
    expect(promptRecallEnabled({ NLM_HOOK_PROMPT_RECALL: "  " })).toBe(false);
  });

  it("opts in with on", () => {
    expect(promptRecallEnabled({ NLM_HOOK_PROMPT_RECALL: "on" })).toBe(true);
  });

  it("stays off when explicitly off, any case", () => {
    expect(promptRecallEnabled({ NLM_HOOK_PROMPT_RECALL: "off" })).toBe(false);
    expect(promptRecallEnabled({ NLM_HOOK_PROMPT_RECALL: "OFF" })).toBe(false);
  });

  it("keeps legacy set values enabled (existing installs untouched)", () => {
    expect(promptRecallEnabled({ NLM_HOOK_PROMPT_RECALL: "live" })).toBe(true);
    expect(promptRecallEnabled({ NLM_HOOK_PROMPT_RECALL: "1" })).toBe(true);
  });
});
```

- [ ] **Step 2: run to verify the flip cases fail**

Run: `npx vitest run tests/integration/prompt-recall-hook.test.ts`
Expected: FAIL on "defaults OFF when the var is unset" and the empty-value case; legacy cases pass.

- [ ] **Step 3: implement the flip**

```ts
/**
 * Whether the per-prompt ambient recall hook should run at all.
 *
 * Pull-first posture (default since #392, 2026-07-03): fresh installs run
 * per-prompt ambient recall OFF and agents pull memory on demand via the
 * recall MCP tools. Measured basis (U1, locked judge): pulls 72.4% useful
 * vs ambient injection 18.2%/7.9%. NLM_HOOK_PROMPT_RECALL=on opts back in;
 * any other already-set value keeps its pre-flip meaning (non-"off" = on)
 * so existing installs are untouched. Independent of NLM_HOOK_MODE, which
 * governs the once-per-session passive layer (session-start hook), which
 * stays on.
 */
export function promptRecallEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env["NLM_HOOK_PROMPT_RECALL"]?.trim();
  if (raw === undefined || raw === "") return false;
  return raw.toLowerCase() !== "off";
}
```

- [ ] **Step 4: gate**

Run: `npm run typecheck && npm test`
Expected: PASS (watch for any other test that assumed default-on; if one exists, align it with the pinned semantics, do not weaken it).

- [ ] **Step 5: rebuild bundles and commit (one commit)**

```bash
npm run build
git add src/hook/prompt-recall-hook.ts tests/integration/prompt-recall-hook.test.ts plugin/scripts
git commit -m "feat(hook)!: pull-first default, per-prompt ambient recall off on fresh installs (#392)"
```

Verify with `git show --stat HEAD` that the refreshed `plugin/scripts/*.mjs` are IN the commit (the codex plugin bundles the same hook source).

### Task 2: contract templates, setup output, docs

**Files:**
- Modify: `templates/agent-contract/claude-code.md` ("When to recall" + "The pointer block" sections)
- Modify: `templates/agent-contract/generic.md` (same two sections)
- Modify: `src/install/setup.ts` (claude-code case, after the hooks-installed message ~line 470)
- Modify: `README.md` (hooks narrative ~line 103 and 133; env table ~line 338 gains the `NLM_HOOK_PROMPT_RECALL` row)
- Modify: `docs/hooks.md` (UserPromptSubmit row + modes section)

**Interfaces:**
- Consumes: the pinned contract copy direction and flip semantics above. No code interfaces; `nlm init` reads the templates verbatim at runtime (src/cli/init.ts:37-40), so template edits ship without code changes.

- [ ] **Step 1: claude-code.md "When to recall"**

Insert the trigger list before the existing example bullets:

```markdown
### When to recall

Pull memory at these moments, not just when the phrasing sounds historical:

- **Task start.** Before starting substantive work, call `recall_sessions` on the task's subject. Prior sessions routinely contain decisions and dead ends that change the approach.
- **Before re-deriving a decision.** If you are about to reason out something that has plausibly been settled before (an architecture choice, a tool selection, a naming decision), check first. Re-derivation is how agents silently contradict prior work.
- **Unfamiliar references.** When the user mentions a project, system, client, or entity you do not recognize from the current conversation, recall it before asking the user or guessing.
- **After compaction.** When the conversation has been summarized or compacted, re-pull the sessions and facts relevant to the active task; the summary dropped detail you may need.

Call `recall_sessions` before answering whenever the prompt references past work, prior decisions, or unresolved questions. Examples that should trigger recall:
```

(existing example bullets and the skip paragraph stay unchanged below this)

- [ ] **Step 2: claude-code.md "The pointer block"**

Replace the section body:

```markdown
### The pointer block

At session start, NLM's hooks inject a pointer block listing possibly-relevant sessions with their ids and labels. Read this block first. It arrives once per session: NLM does not inject memory on every prompt, so mid-conversation memory access is your job via the recall tools. When a session looks relevant, call `get_session` to fetch its full transcript before drawing on it.
```

- [ ] **Step 3: generic.md, same two revisions in its register**

"When to recall" gains a prose+list version of the same four triggers ahead of the existing trigger sentence; "The pointer block" section states the block arrives at session start and that per-prompt injection is not part of the contract. Keep the "implicit references are the dangerous case" sentence; it earned its place.

- [ ] **Step 4: setup output**

In `src/install/setup.ts` claude-code case, after the hooks success branch (`hs.stop(...hooks installed...)`), add:

```ts
log.info("Recall posture: pull-first. Agents pull memory via the recall MCP tools; the session-start pointer block stays on.");
log.info("  Ambient per-prompt injection is off by default. Set NLM_HOOK_PROMPT_RECALL=on to re-enable it.");
```

- [ ] **Step 5: README + docs/hooks.md truth pass on the posture**

- README hooks narrative (~line 103): state that on fresh installs the UserPromptSubmit lane is off by default (pull-first, measured: pulls 72.4% useful vs 18.2% ambient on the same judge) and SessionStart still injects the pointer block; `NLM_HOOK_PROMPT_RECALL=on` re-enables per-prompt injection.
- README ~line 133 ("All three fail-open..."): keep fail-open wording, adjust any sentence that implies every prompt gets injection.
- README env table: add row `NLM_HOOK_PROMPT_RECALL` | `(unset = off)` | `Per-prompt ambient recall. Off by default (pull-first); set on to inject a pointer block on every prompt. off disables explicitly.`
- docs/hooks.md UserPromptSubmit table row + the modes section: note the lane is gated by `NLM_HOOK_PROMPT_RECALL` and off by default (pull-first posture, #392); SessionStart unaffected. Do not claim a version number; the release that carries this is not cut in this wave.

- [ ] **Step 6: gate + commit**

Run: `npm run typecheck && npm test`
Expected: PASS (setup.ts change is print-only; if a setup snapshot test exists and fails, update its expectation).

```bash
git add templates/agent-contract/claude-code.md templates/agent-contract/generic.md src/install/setup.ts README.md docs/hooks.md plugin/scripts
git commit -m "docs(contract): pull triggers in the agent contract, pull-first posture across setup output and docs (#392)"
```

If `npm run build` changes `plugin/scripts` because of the setup.ts edit, include the refreshed bundles.

### Task 3 (controller): reviews, merge, board, CHANGELOG

- [ ] Per-task Sonnet reviews (binding constraints pasted in); Opus whole-branch final review (Task 1 touches the hook hot path).
- [ ] Hygiene gate: python byte-check over added diff lines (NUL bytes, em dashes), narration-comment read, no gitignored .superpowers files staged.
- [ ] Public scrub over the unpushed range; `git pull --rebase origin main`; merge; push; `gh run watch` + print conclusion AND displayTitle.
- [ ] Board: #392 -> Done with dated note (flip + contract shipped, commit ids). File NEW row: "+14d pull-frequency re-measure (post pull-first ship)" P2, due 2026-07-17, Notes: run `scripts/eval/pull-usefulness.ts` over the post-ship window (conversation-id joins are first-class now); targets: pulls/day up from 3.5, usefulness@pull >= 60%; compare per-runtime splits.
- [ ] CHANGELOG entry (cap 10, archive oldest if needed).
