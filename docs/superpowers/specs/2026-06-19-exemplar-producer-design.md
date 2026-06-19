# Code-exemplar producer: passive recall of historically-beneficial choices

Status: design / approved (pending spec review)
Date: 2026-06-19
Related: docs/plans/2026-06-15-code-exemplar-recall.md (the lane this populates), NocoDB #330

## Goal

The code-exemplar lane shipped (v0.13.0–v0.14.1) but stays empty: nothing
populates it. This spec defines the **producer** — how exemplars get captured —
and how they reach the agent.

The end outcome we are building toward: **agents passively know what choices
have been made historically that were beneficial to the user and the LLM**, and
that knowledge stays **relevant to the current chat** and **genuinely useful to
the agent** (not token noise). Two consequences drive the design:

1. The unit of capture is a *beneficial choice* — committed code plus the
   decision/task it implemented — not a raw code blob.
2. Recall is **passive and contextual** first (it surfaces automatically when
   relevant), with the on-demand `recall_code` tool as the heavyweight pull.

It must work for **anyone leveraging an agent during a normal coding session**,
with no per-user wiring of bespoke launchers.

## Decision (why this shape)

Capture is **triggered by session ingest**, the code is **sourced from the git
commit** the session produced, the **LLM labels** on top of a deterministic
base, and every label is **human-supersedable**.

- **Not pure transcript extraction.** Making an LLM mine code out of a messy
  transcript and guess which version was final / whether it worked produces a
  low-precision corpus — the failure mode NLM exists to avoid. Anchoring to a
  git commit removes the guess: the diff is the final, accepted code.
- **Not a post-commit hook (for v1).** NLM already ingests the session that
  contains the commit, so the trigger is free — no install step, no commit-time
  latency, and it backfills the existing corpus retroactively. A hook would
  leave most users' corpora empty (they must install it per repo) and is a
  marginal gain for an agent-centric audience. The hook becomes a trivial
  optional alt-trigger later (§9), because it would call the same engine.
- **LLM in the loop where it adds value.** Outcome is bootstrapped
  deterministically (committed = `pass`); the LLM only *refines* — it writes the
  searchable task-context and nudges the label (e.g. `pass` → `fix` for a
  bugfix). A narrow, well-posed judgment on a small clean input, not a
  hallucination risk.

## Architecture

One reusable engine, two triggers (only the first ships in v1):

```
                        ┌─────────────────────────────────────────────┐
  session ingest  ──▶   │  exemplar engine:                            │
  (scheduler tick)      │   (repo, sha, session-context)               │
                        │     → extractFromGitSha (deterministic hunk) │
  [v2] post-commit ──▶  │     → label (bootstrap + LLM refine)         │
       hook             │     → insert + CodeRankEmbed                 │
                        └─────────────────────────────────────────────┘
                                          │
                          recall: passive pointer-block injection
                                   + recall_code pull tool
```

The engine — `(repo, sha, context) → labeled exemplar` — is the only hard part
and is shared by any trigger.

## Components

### A. `extractFromGitSha` decoupled from `Signal`

Current signature (src/core/exemplars/extract-exemplar.ts:86) takes a `Signal`.
Refactor to a plain params object so non-signal callers (the ingest producer)
can use it:

```ts
extractFromGitSha(params: {
  repo: string;
  sha: string;
  installScope: string;
  outcome: CodeExemplarOutcome;     // bootstrapped 'pass' for a commit
  model?: string;                    // 'unknown' at commit time
  sessionId?: string | null;
  ts?: string;
  repoPath?: string;                 // defaults to repo
}): CodeExemplarInput | null
```

`extractFromDetail` and the existing `/api/signal` capture path (the
producer-supplied-code branch) keep working via a thin `Signal`-adapting
wrapper so nothing regresses.

### B. Capture: `drainExemplars()` in the scheduler tick

Hooks into the background scheduler tick (src/core/scheduler/scheduler.ts),
**after `drainSignals()` and before/around `insertSession()`** — the only point
where `chunk.projectDir`, `chunk.body`, and the `classification` are all live.
Gated by `NLM_CODE_EXEMPLARS_ENABLED` (same gate `drainSignals` already checks).

Per chunk:
1. **Detect commit sha(s)** deterministically. Scan `chunk.body` for git commit
   output (`/\[[^\]]*\b([0-9a-f]{7,40})\]/` matching `[branch abc1234] msg`,
   plus the `chunk.signals` git_sha field if present). No LLM in detection.
2. **Resolve repo** = `chunk.projectDir` (the session's cwd). If absent, skip.
3. For each sha: `extractFromGitSha({ repo, sha, installScope, outcome: 'pass',
   sessionId: chunk.id })`. Runs `git show` against the local repo. On any
   failure (repo moved, sha gone after rebase, not local) → returns null → skip.
   **Graceful: we miss some, we never store a wrong one.**
4. **Label** (§C).
5. `exemplarStore.insert()` + fire-and-forget CodeRankEmbed on
   `taskContext + "\n" + code` (same pattern as the existing /api/signal hook).

Runs in the background tick — never blocks the user, never blocks `insertSession`
(wrapped so a capture failure can't fail session ingest).

### C. Labeling: deterministic base + LLM refinement, reusing the classifier's "choices"

The classifier has **already run** on this chunk and produced
`{ summary, decisions, entities, label }`. The session's `decisions` are
literally "the choices that were made" — the thing we want to attach to the code.

- **`taskContext`** (the searchable label) is composed from the commit message +
  the chunk's `classification.summary`, biased toward any `decisions[]` entry
  that references the changed files/area. This links *code* (from git) to the
  *decision* (from the classifier) for the same session — no separate extraction
  pass needed for the common case.
- **`outcome`** is bootstrapped to `pass` (committed) and then **refined by a
  lightweight LLM call** — on by default, since LLM-in-the-loop labeling is the
  explicit intent. A single small call on commit-message + diff + summary may
  set `fix`/`exhausted` and drop trivially-uninteresting diffs (lockfile bumps,
  formatting-only). This call is *separate* from the classifier (not a schema
  extension) to keep risk off the already-strained classifier path (#316). An
  opt-out env flag (`NLM_EXEMPLAR_LLM_LABEL=0`) lets a cost-sensitive deployment
  fall back to deterministic-only labeling (commit-msg taskContext, `pass`).

`normalizeExemplar` still enforces the 2–200 meaningful-line band and
`code_hash` dedup, so volume is bounded; `applyBucketCap` (already built) caps
per `(scope, repo, lang, outcome-class)`.

### D. Supersedence with `llm` / `human` provenance

Exemplars are currently append-only with no verdict. Add an editable verdict
that mirrors how facts already work (facts carry `superseded_by` / `retired_at`),
but with the provenance made explicit:

New columns on `code_exemplars` (both SQLite migration + the PG mirror):

| Column | Meaning |
|---|---|
| `retired_at TEXT` (nullable) | non-null = excluded from recall (the "verdict") |
| `label_source TEXT` `'llm'\|'human'` (default `'llm'`) | who last set the verdict/outcome |

Resolution rule — **human wins on the stack**:
- Capture and any later LLM-driven re-label/retire write `label_source='llm'`,
  but **are a no-op when the current `label_source='human'`.** The LLM may freely
  revise its own judgments; the moment a human touches an exemplar, the LLM stops
  overriding it.
- A human override always applies and sets `label_source='human'`.

Human override surface (minimal): `POST /api/exemplar/:id/verdict`
`{ retire?: bool, outcome?: ... }` (Bearer/Origin) + a `supersede_exemplar` MCP
tool wrapping it. Recall excludes `retired_at IS NOT NULL`; `getById` still
returns retired rows for the audit trail — same contract facts honor.

(A full per-change audit *stack* is deferred — the sticky-provenance rule
delivers the priority behavior described; a history log is a later add.)

### E. Recall: passive injection first, pull tool second

This is what makes it "passively known and useful without noise."

- **Passive (primary).** Extend `RecallService.search()` (src/core/recall/
  recall-service.ts, step 6 — where related facts are injected today) with a
  parallel `pickRelatedExemplars(result.results, exemplarStore, codeEmbedder)`.
  Render a third pointer-block section (src/core/hook/pointer-block.ts, after
  "Known facts") that is **deliberately lean**: per top exemplar, one line —
  task-context + outcome + repo + a `recall_code` hint — **not the code body**.
  The heavy content (the actual chunk) is pulled on demand via `recall_code`
  only when the agent decides it's relevant. This keeps the injected block
  small, relevant, and within the existing score-threshold / dedup / per-fire
  caps that `select.ts` already enforces.
- **Relevance.** Matching uses CodeRankEmbed (query-prefixed) over the exemplar
  vectors — the same space `recall_code` uses — so passive surfacing is
  behaviour-relevant, not topic-relevant. `RecallService` gains a `codeEmbedder`
  dep for this (it currently only holds the prose embedder).
- **Pull (secondary).** `recall_code` (already shipped) returns the full chunks.
  Excludes retired exemplars.

## Data flow (capture → recall)

1. Agent codes in a session, commits. Adapter ingests the session (existing).
2. Scheduler tick classifies it (existing) → `drainExemplars()` detects the sha,
   `git show`s the diff, labels it from the commit msg + classified decisions,
   stores + embeds it. `label_source='llm'`.
3. Later, the agent (any runtime) is about to do related work. The
   UserPromptSubmit recall hook surfaces a one-line pointer to the prior
   beneficial choice; the agent calls `recall_code` if it wants the code.
4. If a surfaced exemplar is wrong/stale, a human retires or relabels it
   (`label_source='human'`); the LLM never re-overrides it.

## Error handling / graceful degradation

- Capture is best-effort and isolated: any failure (no sha, repo absent, `git
  show` fails, embed fails) skips that exemplar and **cannot** fail session
  ingest. Fail loud only at the genuine boundary (`normalizeExemplar` validation).
- Remote daemon / repo-not-local: `git show` fails → no exemplar. Documented
  limitation; the v2 hook (or producer-supplied `detail.code`) covers it.
- Flag off: `drainExemplars` is a no-op; recall injection skipped; `recall_code`
  unregistered (already the case).

## Testing

- `extractFromGitSha` decoupling: existing signal path still green; new
  params-object path covered against a fixture git repo (init → commit →
  extract → assert hunk + lang + outcome).
- `drainExemplars`: fixture session chunk with a commit-output body + a temp git
  repo → asserts an exemplar lands; body with no sha → no-op; repo missing →
  no-op; flag off → no-op. (Mirrors `drainSignals` tests.)
- Labeling: taskContext composed from commit msg + summary; the optional LLM
  refine is behind a fake so the test is deterministic.
- Supersedence: human verdict sticks (LLM re-label no-ops); human can always
  override; recall excludes retired; getById still returns retired.
- Passive recall: `pickRelatedExemplars` returns lean pointers; pointer-block
  renders the section; retired excluded; respects caps/threshold.
- Both storage backends: the verdict columns + queries run the shared contract
  on SQLite and Postgres (the PG store + container harness already exist).

## Phasing (rollout)

Independently shippable, each valuable alone:

1. **Phase 1 — Capture.** §A + §B + §C + the SQLite/PG schema for verdict
   columns (created now even if §D's write path lands in Phase 3). After this,
   the lane *populates automatically* from normal sessions — the core value.
2. **Phase 2 — Passive recall.** §E. Makes the captured choices passively known.
3. **Phase 3 — Supersedence.** §D write surface (REST + MCP) + the human-wins
   resolution. Correction layer.

Each phase becomes its own implementation plan. Phase 1 is the first plan.

## Out of scope (v1, YAGNI)

- **Post-commit git hook** as a trigger — deferred to v2 as an optional
  alt-trigger that POSTs `{repo, sha}` to the same engine; converges with the
  planned #276 commit-hook (commits → facts) so there is one hook, not two.
- **Negatives / survival tracking** — reverted-commit → `survived=0` is a clean
  follow-on the schema already supports; v1 captures positives (committed) only.
- **Multi-hunk per commit** — one exemplar (largest hunk) per commit, as today.
- **Remote-daemon diff-shipping** — assumes local repo access (the universal
  local case).
- **Full supersedence audit stack** — sticky provenance now; history log later.

## Feasibility — verified

- Repo cwd IS available at capture time as `SessionChunk.projectDir`
  (src/core/adapters/claude-code.ts reads `evt.cwd`); it is *not* persisted, so
  capture must run in the ingest tick — which this design does.
- Capture seam (`drainExemplars` after `drainSignals`) and the recall seam
  (`RecallService` step 6 + `pointer-block`) both exist and are extension-ready.
- `extractFromGitSha` decouples from `Signal` with a mechanical signature change.
