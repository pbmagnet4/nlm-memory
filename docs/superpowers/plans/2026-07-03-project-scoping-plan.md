# Within-Install Project Scoping (#348) Implementation Plan v3

> **DO NOT EXECUTE WITHOUT EDWARD SIGN-OFF.** This is a Tier 2 change (schema + a security-relevant recall filter). It is design-only until Edward approves the companion design doc (`docs/superpowers/specs/2026-07-03-project-scoping-design.md`, v3). A filtering bug on this path is a cross-client data leak, so no task here is landed on the strength of this plan alone. The enforcement flip additionally requires a SECOND sign-off on the coverage number (Task 8).

> **For agentic workers (after sign-off only):** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development or superpowers:executing-plans to implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Give the operator's central install a project/client scope so recall cannot commingle clients, per the Phase 1 (2026-06-22) Option C decision. Add a `scope` dimension to sessions/facts/exemplars/signals/workstreams, derive the active scope at each recall surface (mis-resolution impossible by construction), enforce a fail-closed SQL-level filter on every corpus-returning read (search, vector-neighbor resolution, by-id, aggregation), and ship the deliberate cross-scope escape hatch with an audit log. Stamp and backfill behind flags first; flip enforcement only after a coverage gate and a second sign-off.

**Plan v2 note:** v1 went through an adversarial leak-hunt (8 findings, all accepted; design doc section 10 is the disposition record). v2 adds: signals + workstreams scope columns and backfill (F5), the fact vector-path SQL scoping (F2), by-id scope checks (F3), the full surface coverage in Task 6 including the fact caller chain (F4, F8), the strict MCP derivation (F1), and pinned deriveScope match semantics (F7).

**Plan v3 note:** the verification pass raised N1-N5. v3 corrects the signal derivation (N1: producer-supplied `repo_path` or `session_id` inheritance; basename-to-scope mapping FORBIDDEN), adds the explicit-scope disagreement audit (N2), the duplicate-stem fail-closed rule (N3), pinned NULL binding semantics gated on the stamp flag (N4), and the `rebind_session` cross-scope gate (N5).

**Measured / grounded inputs (load-bearing, verified 2026-07-03):**
- Sessions store no project identity today. `projectDir` is extracted (`src/core/adapters/claude-code.ts:143`) and rides `SessionChunk.projectDir` but is never persisted; it only feeds exemplar capture and entity registration. Backfill must re-derive from `transcript_path`.
- The exact structural precedent is `workstream_id` (migration 025): `ALTER TABLE sessions ADD COLUMN`, index, and SQL filter in `sqlite-session-store.keywordSearch` (`:791`) plus the semantic row-lookup (`:739-746`). Scope mirrors this.
- The mandatory-filter precedent is `install_scope = ?` in `sqlite-signal-store.ts:48`. The signals `repo` column is a LOGICAL basename by design, never a path (`code-signal.ts:12`; ingest soft-defaults "unknown"), so it CANNOT feed `deriveScope`. The usable anchors: the producer holds the full `repoPath` pre-basename (`code-signal.ts:28`), and every signal has a `session_id` soft link (migration 017). Basename-to-scope mapping is FORBIDDEN (clients share basenames like `website`/`api`/`docs`; a name-keyed bridge collides them into cross-client signal bleed).
- Fact semantic/hybrid recall bypasses SQL pre-filters: `FactRecallService.runSemantic` (`fact-recall-service.ts:225-239`) calls unscoped `semanticSearch` then unscoped `getByIds` and re-filters in JS via `makeFilterPredicate` (`:249-264`), which has no scope check. This is the F2 leak; Task 5 closes it in SQL with the JS predicate as defense in depth.
- `resolveConversationByQuery` scans the 5 most-recently-modified transcripts ACROSS ALL PROJECTS, first substring match wins. Safe for telemetry, mis-attributes under concurrency (F1). It is NOT the primary scope mechanism; Task 6 implements id-keyed resolution primary + a uniqueness-constrained fallback.
- session-start hook already has `working_directory` (`src/hook/session-start-hook.ts:133`); prompt-recall hook (OFF by default per #392) does not read `cwd` today but the payload carries it.
- `get_session` (MCP) and `/api/session/:id` (`app.ts:1465`) return any row by id; supersedence enrichment batch-fetches linked ids. Task 6 adds the scope check (F3).

## Global Constraints

- PUBLIC repo: no internal hostnames, LAN IPs, home paths, client or unreleased-venture names in committed text. Docs say "client A/B". Tests use temp dirs and synthetic paths, never `~/.nlm` and never real project paths.
- No em dashes in added text. No literal NUL bytes. No new dependencies. No narration comments (explain a non-obvious WHY only).
- Gate per task: `npm run typecheck` + `npm test` green. Any task touching a store also runs `npm run test:pg` (scope must reach Postgres parity, not just SQLite).
- Additive, flag-gated: no recall behavior changes for existing installs until `NLM_SCOPE_ENFORCE=1`, and that flag ships default OFF. Stamping (`NLM_SCOPE_STAMP`) and backfill are safe to land first.
- FAIL-CLOSED is the invariant: when the active scope is not positively AND unambiguously derived, a read returns the `global` tier only (signals: nothing), never a client scope, never `scope IS NULL`. Ambiguity counts as non-derivation. Every task preserves this.
- MIS-RESOLUTION invariant: no derivation mechanism may be able to pick the wrong conversation/scope; content-scan results are used only under the Task 6 uniqueness conditions.
- Surface completeness invariant: any read path not covered by a Task 5/6 filter must appear in the design doc section 5 table as OOS-with-rationale; a new read path added during implementation joins the table before it merges.
- `src/` changes: `npm run build` + commit the refreshed tracked plugin bundles in the same commit.
- Worktree `.worktrees/348-scoping`, branch `feat/348-scoping`; `git pull --rebase origin main` before merge; one implementer in the tree at a time.

## Pinned vocabulary (locked before implementation)

- `scope`: TEXT. A normalized project root path, OR an operator alias name, OR the reserved value `global`. NULL = legacy/unclassified. Signals never take `global`.
- `deriveScope(path, aliasMap)`: the ONE normalizer. Absolute, symlink-resolved, trailing-slash-stripped; alias matching is exact-or-longest-prefix on segment boundaries; longest match wins; on equal length a named scope beats a global entry; no match = the normalized path; empty/relative input = null. Lives in `src/core/scope/derive-scope.ts`. Reused by ingest, backfill, and every recall surface.
- `activeScope`: `{ kind: "scoped"; value: string } | { kind: "global-only" } | { kind: "all-scopes" }`. Store read signatures take this non-optionally.
- `scopeClause(activeScope)`: builds the SQL WHERE fragment + bind params. `scoped` -> `(scope = ? OR scope = 'global')`; `global-only` -> `(scope = 'global')`; `all-scopes` -> no restriction. Signal-store variant has no global arm (`scoped` -> `scope = ?`; `global-only` -> match nothing). Lives in `src/core/scope/scope-clause.ts`.

---

### Task 1: scope schema migration (additive)

**Files:** new `migrations/029_project_scope.sql`, `migrations/pg/030_project_scope.sql` (match the pg numbering in the tree), no store code yet.

**Pinned semantics:**
- `ALTER TABLE ... ADD COLUMN scope TEXT;` + index on FIVE tables: `sessions`, `facts`, the code-exemplar table (beside `install_scope`), `signals` (beside `install_scope`), `workstreams`. Index names `idx_<table>_scope`.
- No backfill in the migration. All existing rows are NULL after it. No behavior change.
- Register both migrations in `schema_migrations` the way 025 does. Postgres parity is mandatory in this task, not deferred.

**Tests:** migration applies cleanly on a fresh temp DB and on a DB seeded at the prior version; all five columns + indexes exist; `npm run test:pg` applies the pg migration.

**Commit:** `feat(scope): additive scope column on sessions/facts/exemplars/signals/workstreams (no enforcement)`

### Task 2: the scope derivation core (`deriveScope` + `scopeClause` + alias map)

**Files:** new `src/core/scope/derive-scope.ts`, `src/core/scope/scope-clause.ts`, `src/core/scope/alias-map.ts`, tests beside each.

**Pinned semantics:**
- `deriveScope` implements the pinned match semantics from the vocabulary block EXACTLY (segment-boundary prefix, longest-match-wins, named-beats-global on ties, no-match = normalized path, bad input = null).
- `alias-map.ts`: load and cache `~/.nlm/scopes.json` (memoize per process like `install-scope.ts`); tolerate a missing/malformed file (return an empty map; fail-open on CONFIG, never on the filter). Test-only cache reset like `resetInstallScopeCache`.
- `scopeClause(activeScope)`: pure, returns `{ sql: string; params: string[] }`. Never returns an empty restriction for `scoped` or `global-only`. Includes the no-global signal variant.
- No I/O in `scopeClause` or `deriveScope` beyond the alias-map read.

**Tests:** normalization (symlink, trailing slash, relative rejected); alias collapse (two worktree paths -> one name); global mapping; **nested-path precedence: a client path under a listed global root resolves to the client scope** (F7); segment-boundary check (`/a/bc` does not match `/a/b`); malformed `scopes.json` -> empty map, not a throw; `scopeClause` for each `activeScope` kind including the signal variant, asserting `scoped`/`global-only` always constrain.

**Commit:** `feat(scope): scope derivation with pinned match semantics, alias map, fail-closed scope clause`

### Task 3: ingest stamping (behind `NLM_SCOPE_STAMP`)

**Files:** `src/core/scheduler/scheduler.ts` (session insert path), `sqlite-session-store.ts` + `pg-session-store.ts` (persist `scope` on insert), fact insert path (inherit), exemplar capture (map `repoPath`), signal ingest (`ingest-signal.ts` + the `/api/signal` payload schema + the code-signal producer), workstream creation + binding (`bind-session-to-workstream` path: stamp at creation, enforce same-scope binding), tests beside each.

**Pinned semantics:**
- Gate every stamp on `NLM_SCOPE_STAMP=1`; when off, `scope` is written NULL (today's behavior).
- Session: `scope = deriveScope(chunk.projectDir, aliasMap)` at insert. Fact: inherit the parent session's derived scope (derive ONCE per chunk, pass down; never re-derive per fact). Exemplar: `deriveScope(repoPath)`.
- **Signal (N1):** the `/api/signal` payload gains an optional `repo_path` field; the code-signal producer sends it (it already holds `repoPath` before basenaming). Stamp `deriveScope(repo_path)` when present; else inherit the linked session's scope via `session_id` if that session row exists and is scoped; else NULL. The stored `repo` basename is NEVER an input to scope derivation (FORBIDDEN; see grounded inputs). A signal never takes `global` (a global-derived path stamps NULL for signals).
- Workstream: stamped at creation with the first bound session's scope. The binder only matches a session to a workstream whose scope equals the session's scope; a cross-scope classifier match falls through to create-or-match within the session's own scope. This is the same-scope-members invariant (F5). **NULL semantics (N4):** NULL binds with NULL (a NULL-scoped session matches NULL-scoped workstreams exactly as today), and binder enforcement is gated on `NLM_SCOPE_STAMP`, so pre-flip binding behavior is unchanged and NULL workstreams remain invisible under scoped reads.
- Stamping is WRITE-ONLY in this task: no read path consults `scope` yet.

**Tests:** with the flag on, each object type from a known path stamps the expected scope; global-listed path stamps `global` for sessions/facts and NULL for signals; empty projectDir stamps NULL. Flag off: all NULL and binding proceeds exactly as today (N4 regression guard). Fact inherits. Signal with `repo_path` stamps that scope; signal with only `session_id` inherits; signal with neither stays NULL; two clients sharing a repo basename never co-scope (N1); no code path consumes `repo` for derivation. Binder never binds a scope-A session to a scope-B workstream (creates/matches in A instead); NULL session binds a NULL workstream. pg parity.

**Commit:** `feat(scope): stamp scope across all five tables on ingest behind NLM_SCOPE_STAMP (write-only)`

### Task 4: backfill command

**Files:** new `src/cli/scope-backfill.ts` wired into `src/cli/nlm.ts` (`nlm scope backfill`), tests beside.

**Pinned semantics:**
- Sessions: for every `scope IS NULL` row with a readable `transcript_path`, re-read the transcript's `cwd` (bounded head-read for the first `cwd`), `deriveScope`, UPDATE; cascade to that session's facts and exemplars.
- Signals (N1): join on `session_id` to a backfilled session and inherit its scope; signals with no `session_id` or an unscoped session stay NULL. The stored `repo` basename is never used.
- Workstreams: a workstream whose member sessions (post-session-backfill) are unanimously one scope inherits it; mixed-scope or memberless workstreams stay NULL.
- Missing/unreadable evidence: row stays NULL (safely invisible under fail-closed).
- `--dry-run` (default) prints would-change counts per table per derived scope; `--apply` writes. Idempotent. Never touches `~/.nlm` in tests (temp DB + synthetic transcripts).

**Tests:** dry-run reports without writing; apply stamps derivable rows in all five tables with the cascades above; missing-transcript sessions stay NULL; a signal joins its session's scope and a session-less signal stays NULL; mixed-scope workstream stays NULL; idempotent second run is a no-op; malformed transcript skipped, not fatal.

**Commit:** `feat(scope): nlm scope backfill derives scope for sessions/facts/exemplars/signals/workstreams`

### Task 5: store-level enforcement (the choke point, behind `NLM_SCOPE_ENFORCE`)

**Files:** `sqlite-session-store.ts` (`keywordSearch`, semantic row-lookup, `listByDateRange`, `getById`/`getByIds`), `sqlite-fact-store.ts` (`listForRecall`, `semanticSearch` neighbor resolution, `getByIds`, history reads), the code-exemplar stores, `sqlite-signal-store.ts` (`listForAggregation` + failure-mode reads gain project scope beside `install_scope`), the workstream store (row reads + member listing + merge-suggestion pairing), all pg parity stores, `src/core/recall-facts/fact-recall-service.ts` (`makeFilterPredicate`), tests beside each.

**Pinned semantics:**
- Store read methods gain a NON-OPTIONAL `activeScope` argument (a compile error to omit). Mirror the `workstream_id` handling: append `scopeClause(activeScope)` to the WHERE, bind its params. Gate the clause on `NLM_SCOPE_ENFORCE=1`; off = today's behavior, so this task lands safely before the flip.
- **Vector-path rule (F2):** every embeddings-then-id-resolution path re-applies scope IN SQL at the resolution step. Fact `getByIds` and the session semantic row-lookup (which already reads `workstream_id`) carry `scopeClause`. `makeFilterPredicate` additionally gains a mandatory scope check (defense in depth); the predicate's filter input requires the scope field so a caller cannot construct it without one.
- **By-id rule (F3):** `getById`/`getByIds` filter by scope; a mismatched row is absent from the result (same shape as nonexistent, no existence oracle). The all-scopes sentinel is the only bypass.
- Workstream store: row reads filter `workstreams.scope`; merge-suggestion candidate pairing is same-scope only; member listing routes through the scoped session store (defense in depth).
- Signal store: failure-mode/aggregation reads take `activeScope` with the no-global variant.
- One `scopeClause` call per read method; NO post-fetch scope filtering as the primary control anywhere.

**Tests (the leak suite, design section 7 cases 1-7, 12-16):** seedScopedCorpus fixture (sessions, facts with embeddings, exemplars, signals, workstreams in A/B/legacy/global). Scope A never returns B in keyword/semantic/hybrid; **hybrid-fact vector leak: a scope-B nearest-neighbor fact outside the keyword window is not returned in scope A**; entity/kind-filtered A never returns B; NULL invisible except all-scopes; by-id mismatch = not-found shape; failure-mode block never crosses scopes and an underivable scope yields empty; workstream rollup/suggestions never pair A with B; `listByDateRange` scoped; the guard test that every recall SQL routes through `scopeClause`. pg parity for all.

**Commit:** `feat(scope): fail-closed SQL scope filter on every store read incl. vector resolution and by-id (behind NLM_SCOPE_ENFORCE)`

### Task 6: per-surface scope derivation and wiring (every FILTER row of the surface table)

**Files:** `src/core/recall/recall-service.ts` (accept + thread `activeScope`), `src/core/recall-facts/fact-recall-service.ts` (accept + thread `activeScope` through keyword AND semantic legs), `src/mcp/server.ts` (ALL corpus tools: `recall_sessions`, `recall_facts`, `recall_code`, `recall_workstream`, `get_session`, `get_fact_history`, `work_summary`, `list_merge_suggestions`, `merge_workstreams`, `rebind_session`), `src/http/app.ts` (`/api/recall`, `/api/recall/facts`, `/api/recall-code`, `/api/session/:id`, `/api/facts/history`, `/api/signals/failure-modes`, `/api/signals/stats`), `src/hook/session-start-hook.ts` + `src/hook/recall-over-http.ts` (pass derived scope), `src/hook/prompt-recall-hook.ts` (read `cwd`, derive), new `src/core/scope/resolve-scope-for-call.ts` (the MCP resolver), digest path (`buildWorkDigest` caller), tests beside each.

**Pinned semantics:**
- **MCP resolver (F1):** priority per call = explicit `scope` arg > `conversation_id` resolution > constrained query-scan > `global-only`. `conversation_id` resolution is an exact filename-stem lookup under the transcripts root (never a scan), reading THAT transcript's most-recent `cwd` -> `deriveScope`; unknown id = no resolution. **A stem matching more than one file fails closed to `global-only` (N3): copied/backup project dirs can duplicate a stem, and a duplicate recreates a candidate set.** The query-scan fallback returns a scope ONLY when exactly one scanned candidate contains the query AND it resolves to a single scope; zero, multiple, or ambiguous = `global-only`. Every recall tool schema gains optional `conversation_id` and `scope` args.
- **Explicit-scope disagreement audit (N2):** when an explicit single-scope arg is honored and a concurrently-derivable scope (from `conversation_id` or the constrained fallback) disagrees with it, the read proceeds on the explicit arg but writes a `cross_scope_access.jsonl` line flagged `explicit_scope_disagreement` carrying both values (writer lands in Task 7; the resolver returns the derivable scope alongside so the handler can compare).
- **Fact caller chain (F8):** `FactRecallService.recall` takes `activeScope`; `recallFactsHandler` derives it via the MCP resolver; `/api/recall/facts` reads the explicit `scope` param (absent = `global-only`). Same rule for `get_fact_history` / `/api/facts/history`.
- **By-id surfaces (F3):** `get_session` and `/api/session/:id` derive scope the same way as their siblings and pass it to the scope-checked store read; a cross-scope id yields the standard not-found response. Supersedence/continues enrichment inside recall results omits out-of-scope linked sessions.
- session-start: `activeScope = deriveScope(working_directory)`; null -> `global-only`. Failure-mode block fetch passes the same derived scope (signals variant: empty on non-derivation).
- prompt-recall: read payload `cwd`; same mapping; still OFF by default.
- HTTP `/api/recall`: `?scope=<name|path>` -> scoped; `?scope=all` -> all-scopes (Task 7 audits); absent -> `global-only`.
- `work_summary` + digest: scoped `activeScope` required; `recall_workstream` filters via the workstream store; `list_merge_suggestions` same-scope pairs only; `merge_workstreams` AND `rebind_session` (N5) refuse a cross-scope operation without the sentinel (rebind uses the identical gate + audit as merge; a rebind that would mix scopes in one workstream is the same leak as a merge).
- Nothing derives `all-scopes` implicitly; only explicit flags/args produce the sentinel.

**Tests (design section 7 cases 4, 7-8, 10-11, 15-19 at the surface level):** mis-resolution containment (two transcripts, same query -> global-only; supplied `conversation_id` wins regardless of mtime); duplicate stems -> global-only (N3); explicit-scope disagreement writes the flagged audit line, agreement writes none (N2); non-CC client -> global-only absent explicit arg; session-start with/without cwd; HTTP param present/absent; fact handler chain threads scope through hybrid; by-id refusal through the real handlers; work_summary scope purity; merge AND rebind refusal (N5).

**Commit:** `feat(scope): derive active scope per surface (id-keyed MCP resolution, fail closed to global) and wire every corpus read`

### Task 7: cross-scope escape hatch + audit log

**Files:** `src/http/app.ts` (`?scope=all`), `src/mcp/server.ts` (`scope: "*"`), `src/cli/nlm.ts` recall/search/digest commands (`--all-scopes`), new `src/core/scope/cross-scope-log.ts`, tests beside.

**Pinned semantics:**
- The all-scopes sentinel is producible ONLY by an explicit flag/param/arg. No derivation path yields it (assert in tests that derivation functions can only return `scoped`/`global-only`).
- Every all-scopes read appends one line to `~/.nlm/logs/cross_scope_access.jsonl`: `{ ts, surface, query, scopesTouched, returnedIds, runtime }`. Fire-and-forget, never blocks the read (mirror `logQuery`).
- The sentinel is also what unlocks a by-id read of a mismatched-scope row, a cross-scope `merge_workstreams`, and a cross-scope `rebind_session` (N5); all write the same audit line.
- The writer also carries the `explicit_scope_disagreement` variant (N2): same file, same shape plus a `flag` field and both scope values; emitted by Task 6's handlers when an honored explicit scope disagrees with the derivable one.
- Digest defaults to per-scope; `--all-scopes` digest audits.

**Tests:** all-scopes returns A + B + NULL + global and writes exactly one audit line with correct fields; scoped reads write none; by-id override, cross-scope merge, and cross-scope rebind write audit lines; the disagreement variant records both scopes; derivation can never produce the sentinel.

**Commit:** `feat(scope): explicit cross-scope access with an audit log; never a default`

### Task 8: coverage gate + enforcement flip (SECOND sign-off required)

- [ ] Add `nlm scope coverage`: prints stamped-vs-NULL fraction of the recently-recalled corpus per table (sessions, facts, exemplars, signals, workstreams) and per surface, from a VACUUM INTO snapshot (never mutate live canonical). Output to `.superpowers/sdd/scope-coverage-{result.json,run.log}`, never the session scratchpad.
- [ ] Present the coverage numbers to Edward. Enforcement (`NLM_SCOPE_ENFORCE=1`) flips ON only on his explicit approval of those numbers; document the decision in the campaign ledger. This plan ends at the recommendation; the flip itself is a gated operator action, not an autonomous step.
- [ ] When approved: the flip is a config/env change plus a CHANGELOG entry, with the cross-scope hatch (Task 7) already in place so the escape valve exists the moment filtering turns on.

### Task 9: reviews, merge, board, CHANGELOG

- [ ] Per-task Sonnet reviews; an Opus whole-branch review focused on the leak suite, the store choke point, the vector-resolution paths, and the by-id checks (this is the security-relevant path). Re-run the surface enumeration from the design doc section 5 against the final diff: every corpus-returning read is FILTER-covered or OOS-documented.
- [ ] Public scrub over the unpushed range (no home paths / client names / LAN IPs in committed text or fixtures); NUL / em-dash / narration sweep; merge, push, `gh run watch` green.
- [ ] Board: #348 updated with the derivation-per-surface decision, the fail-closed + mis-resolution rules, and the enforcement gate state (stamped + backfilled vs enforced). CHANGELOG entry. Note the second-sign-off dependency for the flip so it is not lost.
