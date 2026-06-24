# Workstream Abstraction — Design

Date: 2026-06-24
Status: Approved (brainstorm) — pending implementation plan
Relates: work-digest (`2026-06-23-work-digest-operator-time-feedback-design.md`, topic-provider seam), toolbelt-facts idea, code-exemplar lane, recall-precision gate.

## 1. Problem

NLM classifies a session *after the fact* into a scattered bag of entities, then stores them in a `session_entities` junction with no ordering column. Three consequences:

1. There is no coherent answer to "what project/workstream is this session about." The closest proxy — "the session's first classified entity" — is a fiction: `loadEntities` reads the junction through the primary-key index, so "first" is **alphabetically-first**, not most-relevant. This surfaces dotfiles, file paths, and task numbers as topics (observed: a config dotfile taking 59% of a day's attention; task-number "entities"; tool names that span every project).
2. Recall returns scattered sessions, never a project's accumulated context.
3. The work-digest, recall, and any operator-time telemetry all want the same missing primitive: a stable "what was I working on" identity that persists across sessions.

Entities alone cannot be that primitive. There are ~9,200 entities, all still `status=candidate`, because auto-extraction mints nouns faster than anything canonicalizes them. A workstream is a deliberately smaller, operator-meaningful set.

## 2. Goals / Non-goals

**Goal:** a first-class **workstream** — a persistent container a session binds to, under which that session's accumulated knowledge (facts, decisions, open questions, code-exemplars, tooling facts) rolls up over time. One coherent identity that the work-digest attributes time to, recall retrieves, and an external telemetry layer maps to a business function.

**In scope (v1):**
- `workstreams` table + a single primary binding per session.
- End-of-session **authoritative** binding inside the existing classify sweep.
- Match-or-create with duplication control.
- Session-binding fact/exemplar rollup.
- Workstream-level recall.
- Work-digest topic-provider swap (with graceful fallback).
- Lifecycle via supersedence (rebind / merge / rename; split = bulk-rebind).
- Seed + match-only backfill + a locked eval gold set.

**Deferred to v2 (documented, not built):**
- **Start-side provisional binding** (Section 14). No live consumer exists today — facts/exemplars/classification all land at end-of-session — so a mid-session binding would be read by nothing. v1 ships end-side-only, which delivers every measurable win with zero new hot-path code. v2 adds start-side the moment a live consumer exists (a real-time "continuing X" cue, or mid-session workstream-filtered recall).

**Out of scope:** multi-workstream membership per session (v1 is one primary; `session_workstreams` is the named later seam), and any external-telemetry concept inside NLM core (Section 11).

## 3. Concepts — workstream vs thread

"Thread" is already taken: `thread-groups.ts` / `Thread.tsx` use it for the **replaces-chain** (the linear sequence of mechanical re-parses of one session). That is unrelated to this feature and stays as-is. The new concept is the **workstream**. No rename of existing code.

## 4. Data model

Hybrid model: a workstream is its own identity/lifecycle object, but a workstream's *knowledge* is reached through session binding — not a duplicated fact store.

```
workstreams
  id            TEXT PK            -- ws_<ulid>
  label         TEXT NOT NULL      -- operator-meaningful name; LLM-proposed, operator-editable
  status        TEXT NOT NULL      -- active | merged | retired  (v1: active + merged; retired is operator-only; 'dormant' deferred until an auto-transition rule exists)
  merged_into   TEXT NULL REFERENCES workstreams(id)   -- supersedence pointer
  created_at    TEXT NOT NULL
  updated_at    TEXT NOT NULL
  last_session_at TEXT NULL

sessions
  + workstream_id      TEXT NULL REFERENCES workstreams(id)   -- the ONE primary binding
  + binding_source     TEXT NULL    -- classifier | operator   (v2 adds: provisional-recall)
  + binding_confidence REAL NULL    -- normalized top-candidate match score 0..1; NULL when created fresh (top candidate below LOW)

workstream_entities    -- DERIVED matching/cross-ref index, NOT the rollup path
  workstream_id   TEXT NOT NULL REFERENCES workstreams(id)
  entity_canonical TEXT NOT NULL REFERENCES entities(canonical)
  session_count   INTEGER NOT NULL DEFAULT 0
  PRIMARY KEY (workstream_id, entity_canonical)
```

- **Rollup path:** a workstream's facts/exemplars = those whose `source_session_id` / `session_id` is bound to it (`fact.source_session_id -> session.workstream_id`). **No new columns on `facts` or `code_exemplars`.** A denormalized `facts.workstream_id` is added only if query profiling shows the join is hot — not before.
- `workstream_entities` is rebuilt as a side effect of binding; it powers matching and cross-reference, and is never the source of truth for a workstream's knowledge (avoids shared-entity leakage, e.g. a generic tool dragging another workstream's facts in).
- **Atomic rebind:** because rollup is by session binding, flipping `session.workstream_id` moves all of that session's facts/exemplars in one write. This is what keeps RESUME re-classification and operator rebinds cheap; an entity-membership rollup could not do this cleanly.

## 5. Binding lifecycle (v1: end-side only)

Binding happens where classification already happens: the scheduler sweep (`scanOnce`) flushes a transcript once it has been idle for the configured window (mtime-gated), parses, and classifies. There is no explicit "session ended" event; the idle-flush **is** end-of-session. A transcript that grows later is marked RESUMED, re-parsed, and supersedes its prior version — so a binding is re-evaluated for free on resume.

Flow per flushed session:
1. Classifier runs (already happens), producing the session's entities + summary.
2. **Bind:** the match-or-create step (Section 6) sets `session.workstream_id`, `binding_source=classifier`, `binding_confidence`.
3. Update the derived `workstream_entities` and `workstreams.last_session_at`.

This adds no hot-path code, no new LLM call on the prompt path, and no boot-path change. It runs inside a sweep that already classifies.

## 6. Match-or-create

Fully automatic (no review gate); corrections are post-hoc via supersedence (Section 12). Discipline: **match aggressively before creating.**

Build a **deterministic shortlist** (no LLM) from two signals:
- **semantic-neighbor overlap** — `insertSession` already embeds the session through the embedder in the ingest deps, and the matcher runs in that same pipeline, so it reuses that embedding and calls the existing `semanticSearch` to get neighbor sessions, then takes their (chain-resolved) workstreams. This is *not* the start-time PromptSubmit recall, which does not exist at end-of-session — that reuse is the v2 concern in Section 14.
- **entity-overlap** — workstreams whose `workstream_entities` intersect this session's entities (`session_entities` already stores canonical forms), ranked by weighted Jaccard. Note: `entity_variants` is empty with no writer today, so it provides no alias folding; v1's canonicalization substrate is the **seed alias map** (Section 13), not `entity_variants`. Populating `entity_variants` is out of scope for v1, and the create-path label dedup (below) is what guards against case/spacing splits.

Three-band decision on the top candidate's score:
- **≥ HIGH** → auto-bind, no LLM (deterministic match).
- **AMBIGUOUS band** → hand the top 3–5 candidates (label + member entities) to the classifier LLM that is *already running this sweep* → pick-or-create.
- **< LOW** and the LLM declines a match → **create** (last resort). On create, normalize the proposed label and dedup against existing labels (kills obvious case/spacing splits).

HIGH and LOW are **set from the gold-set distribution** (Section 13), not guessed.

## 7. Duplication control

Automatic creation will still produce some near-duplicates. Two defenses:
- **Match-before-create** (Section 6) + label normalization keep the create path narrow.
- **Merge-suggestion pass** (scheduler, low-frequency): score workstream *pairs* by shared entities + co-occurring sessions + label edit-distance; write high-similarity pairs to a merge-suggestion surface with one-click merge. This is cleanup, not a gate — it preserves "bind automatically now, correct later."

## 8. Accumulation (session-binding rollup)

A workstream's accumulated knowledge is everything produced while working on it:
- **facts/decisions/open-questions:** `facts WHERE source_session_id IN (sessions bound to ws)`, supersession-filtered (current facts only).
- **code-exemplars:** `code_exemplars WHERE session_id IN (...)`.
- **tooling facts** (toolbelt idea): same path once those facts exist — they are session-sourced, so they roll up with no extra wiring.

No new storage for accumulation; it is a query over existing `source_session_id` / `session_id` columns plus the one new `session.workstream_id` binding. Rollup resolves `merged_into` first (via `resolve.ts`), so a merged workstream's sessions still aggregate under the live survivor without rewriting any `session.workstream_id`.

## 9. Recall integration

- New `recall_workstream(idOrLabel)`: returns the workstream's member sessions (newest-first), rolled-up current facts/decisions/open-loops, and code-exemplars — the coherent project view the scattered-session recall could not give.
- `recall_sessions` gains an optional `workstream` filter.
- Merge chains resolve through `merged_into` to the live workstream before querying.

## 10. Work-digest integration

The topic provider becomes:

```
session.workstream_id present  -> workstreams.label (resolved through merged_into)
otherwise                      -> current behavior (alias-map / first-entity)
```

A small, well-scoped change at the documented seam — not literally one line: `TopicInput` gains the session's `workstream_id` + resolved label, `listByDateRange`'s session projection threads the new column, and the provider is rewired (~3 files). The seam was designed for exactly this extension, so blast radius is low. The fallback keeps the digest working for unbound sessions during rollout instead of going blank. For bound sessions this also retires the alphabetically-first dependency entirely.

## 11. External telemetry seam (layering)

NLM core exposes a stable `workstream_id` on digest and recall outputs — and nothing more. An external operator-telemetry layer maps `workstream -> business function` on its own side of the topic-provider seam, exactly as the work-digest design drew the line. No external-telemetry concept enters NLM core, and no core code path references one. "Telemetry hooks" in scope means precisely: a stable, exposed `workstream_id`.

## 12. Lifecycle & supersedence

All corrections are supersedence-style, audit-trailed, operator-initiated, no gate:
- **rebind_session(session, workstream)** — fix a wrong binding (atomic; Section 4).
- **merge_workstreams(from, into)** — set `from.merged_into = into`, union `workstream_entities`; queries resolve through the chain. Mirrors the replaces-chain resolution.
- **rename_workstream(id, label)** — relabel.
- **split** = bulk `rebind_session` of a subset to a new workstream. No new primitive.

Exposed as MCP tools alongside the existing supersede tools.

## 13. Seed, backfill, rollout

Real-data-gated, reversible, in order:

1. **Schema** — add tables/columns (additive migration).
2. **Seed** — create the operator's existing project taxonomy as `active` workstreams from the local alias map at `~/.nlm/work-topics.json` (operator-local, not in this repo); populate `workstream_entities` from the map. Gives the matcher a strong prior on day one and resolves cold-start (the matcher has something to match against immediately).
3. **Validate** — replay a held-out sample against the seed set; measure match precision/recall on the **locked gold set** (~50 historical sessions hand-labeled from their transcripts/labels, *independently of the seed alias map* — grading the matcher against its own seed would inflate precision). Set HIGH/LOW from this distribution.
4. **Backfill (match-only)** — bind historical sessions to seed workstreams when confident; **never create** during backfill. Deterministic, no LLM fan-out across history, no duplication risk. Unmatched sessions stay `NULL` and are picked up by forward binding. Sets only `workstream_id`; reversible.
5. **Verify** — confirm the digest reads workstream labels on the historical days already validated during brainstorming (a venture workstream day and a client-site workstream day).
6. **Flip** — switch the digest topic provider from alias-map to `session.workstream`. The alias map retires as a runtime stopgap and persists as the seed-of-record.

## 14. v2 — start-side provisional binding (deferred)

When a live consumer exists, add a provisional bind at the first prompt: reuse the recall the PromptSubmit hook already makes, take the dominant `workstream_id` among hits above a confidence threshold, write it as `binding_source=provisional-recall`. Hard aborting timeout; fail-open to unbound; never blocks or slows the prompt. The end-side sweep then confirms/corrects it. Purely additive: the field, matcher, and workstream set already exist in v1, so v2 only writes the same field earlier.

## 15. Module layout

```
core/workstream/
  model.ts          pure types
  match.ts          pure: shortlist scoring + band decision -> bind | create
  resolve.ts        pure: merged_into chain -> live workstream
  rollup.ts         queries: workstream -> facts/exemplars (via session binding)
  bind.ts           loader: invoked by scanOnce after classify; the only I/O module
storage:            workstreams + session.workstream_id + workstream_entities (sqlite + pg parity)
```

Pure core depends on nothing but inputs; `core/` never imports an adapter. One source of truth — runtime and eval import the same matcher module.

## 16. Testing & eval

- **Pure units (TDD):** matcher scoring/bands, merge-chain resolution, rollup queries, topic-provider swap + fallback.
- **Integration:** `scanOnce` end-side bind on a fixture transcript; supersedence (rebind/merge/rename) audit trail; sqlite/pg parity.
- **Eval:** locked ~50-session gold set (hand-labeled independently of the seed map, per Section 13) drives matcher precision/recall and threshold-setting. Locked like the usefulness-judge so results are comparable across runs.
- `npm run test` + `npm run typecheck`. v1 is hot-path-free, so no `build:server` + daemon-restart gating beyond the normal sweep.

## 17. Risks & open questions

- **Matcher precision is load-bearing.** Weak matching reproduces the candidate-entity swamp as a workstream swamp. Mitigated by seed prior + match-before-create + merge suggestions + gold-set thresholds. The gold set must be built before backfill.
- **Label quality** from automatic creation can drift; seed labels are clean, new ones are LLM-proposed + operator-renamable. Acceptable for v1.
- **One-primary loses multi-project sessions** in recall (a session covering two projects surfaces under one). Consistent with the digest's dominant-session attribution; `session_workstreams` is the named seam if this bites.
- **Thin one-off workstreams.** A genuinely novel admin/one-off session below LOW where the LLM still elects to create yields a workstream with a single session. Acceptable: the merge-suggestion pass folds near-duplicates, and operator `retire` removes dead ones. If these accumulate, that is the signal to define the deferred `dormant` auto-transition.
- **Open:** exact weighting of recall-overlap vs entity-overlap in the shortlist score (resolve empirically against the gold set, not by guess).
