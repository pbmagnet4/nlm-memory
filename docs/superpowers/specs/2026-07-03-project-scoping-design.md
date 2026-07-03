# Within-Install Project Scoping Design v3 (#348)

**Status:** DESIGN v3 / awaiting Edward sign-off (Tier 2: schema + recall-path architecture). v1 (same date) went through an adversarial leak-hunt review that returned 8 findings; v2 folded all of them in. The verifier confirmed F1-F4 and F6-F8 closed, flagged F5's signal remedy as unimplementable as written, and raised 5 new items (N1-N5); v3 is the targeted patch. Disposition record in section 10.
**Date:** 2026-07-03
**Phase:** Phase 2 of the per-install privacy work. Phase 1 (the 2026-06-22 design) chose Option C: deployed clients get a separate install each (a physically separate DB + loopback daemon is the boundary, and it is free), while the operator's central workspace, which commingles many clients in one corpus, needs a project/client scope so recall does not cross client boundaries. Phase 1 (egress disclosure + the data-boundary doc) shipped. This design specifies the scope model and, critically, how the active scope is derived at recall time.

This document is DESIGN ONLY. No product code ships from it. Implementation is gated on Edward's sign-off and lives in the companion plan (`docs/superpowers/plans/2026-07-03-project-scoping-plan.md`), which is also gated.

---

## 0. What the code actually does today (grounded)

The recommendations below rest on these verified facts about the current tree:

- **Sessions carry no project column.** `sessions` (migrations/000) has no `project_dir`, `repo`, or `scope`. The adapter DOES extract `projectDir` from each transcript (Claude Code reads the `cwd` field off the jsonl events, `src/core/adapters/claude-code.ts:143`), and it rides on `SessionChunk.projectDir`, but the session store never persists it. At ingest it flows only to (1) code-exemplar capture (`repo`/`repoPath`, `src/core/exemplars/capture-from-session.ts:48`) and (2) entity registration. So the existing session corpus has no stored project identity to filter on. Backfill must re-derive it from `transcript_path`.
- **`install_scope` already exists, but only on `signals` and `code_exemplars`.** It is a per-install UUID (`src/core/signals/install-scope.ts`), and the signal store already filters every read with a mandatory `install_scope = ?` WHERE clause (`src/core/storage/sqlite-signal-store.ts:48`). That is the precedent for a mandatory, SQL-level scope filter. It does NOT solve within-install project scoping: one install has one `install_scope`, so all of the operator's clients share it. Signals carry a `repo` column, but it is a LOGICAL basename by design, never a path (`src/core/signals/code-signal.ts:12`; ingest soft-defaults it to "unknown"), so it cannot feed `deriveScope`. The anchors that DO exist: the producer holds a full `repoPath` before basenaming (`code-signal.ts:28`), and every signal carries a `session_id` soft link (migration 017). Those two are what make project-scoping signals deliverable (section 2).
- **`workstream_id` is the exact structural precedent for adding a scope column.** Migration 025 does `ALTER TABLE sessions ADD COLUMN workstream_id`, indexes it, and filters it at SQL in the store: `keywordSearch` appends `AND s.workstream_id IN (...)` (`src/core/storage/sqlite-session-store.ts:791`), and the semantic path filters on the row lookup that already reads `workstream_id` (`:739-746`). Workstreams themselves carry NO scope today, so a workstream can straddle clients (section 2).
- **Fact semantic recall resolves vector neighbors OUTSIDE any SQL pre-filter.** `FactRecallService.runSemantic` (`src/core/recall-facts/fact-recall-service.ts:225-239`) embeds the query, calls unscoped `factStore.semanticSearch(vector)`, batch-fetches missing neighbors via unscoped `getByIds`, then re-applies filters in JS via `makeFilterPredicate` (`:249-264`), which checks supersedence/confidence/subject/predicate/kind and NOTHING about scope. This is the bypass section 4 closes.
- **By-id reads return any row.** `get_session` (`src/mcp/server.ts`) and `/api/session/:id` (`src/http/app.ts:1465`) fetch by primary key with no context check, and supersedence enrichment batch-fetches linked sessions by id.
- **Recall surfaces and the context each has:**
  - **session-start hook** (`src/hook/session-start-hook.ts`): HAS `cwd`/`working_directory` and `project_name`. Strong scope signal, present by construction. Passive layer stays ON.
  - **prompt-recall hook** (`src/hook/prompt-recall-hook.ts`): OFF by default since #392 (pull-first posture). Reads `prompt`, `session_id` (the conversation id), and `transcript_path` from stdin. Does NOT currently read `cwd`, though Claude Code's UserPromptSubmit payload carries it.
  - **MCP recall tools** (`src/mcp/server.ts`): mounted as a stateless HTTP transport in the Hono app. A tool handler receives ONLY its declared args plus the client version. It has NO cwd. `resolveConversationByQuery` (`src/core/hook/resolve-conversation-by-query.ts`) exists for pull ATTRIBUTION: it scans the 5 most-recently-modified transcripts across ALL projects for an exact query substring, first match wins. Adequate for telemetry, NOT for a security decision (section 3).
  - **HTTP `/api/recall`** (`src/http/app.ts:583`): query params only. No cwd, no scope.
  - Beyond these, the daemon exposes many more corpus-returning reads (digest, workstream rollup, fact history, live-UI feeds, dataset export). Section 5 enumerates every one with a disposition.

---

## 1. Threat model

### What a leak looks like, concretely

The operator's central workspace holds sessions, facts, and exemplars from client A, client B, and the operator's own general work in ONE database. A leak is: while the operator is working for client B, a recall surface returns content that originated in client A's work. Concretely:

- A **session** pointer surfaces "as we decided for client A, the API base is `x`" into a client-B conversation.
- A **fact** (`recall_facts`) returns a client-A attribute (a credential shape, a pricing number, an internal endpoint) while scoped to client B. Including via a VECTOR NEIGHBOR: a scope-B fact that is semantically close to a scope-A query.
- A **code exemplar** (`recall_code`) surfaces a snippet whose `repoPath` belongs to client A.
- The **session-start pointer block** cold-starts a client-B session with client-A pointers, or its failure-mode block surfaces a client-A failure signal (with client-A endpoint text) at a client-B cold start.
- A **by-id fetch** (`get_session`) resolves a stale cross-scope pointer id from an old transcript and returns the full body.
- A **digest or workstream rollup** aggregates activity across clients into one recap that then lands in one client's context.

The damaging property is not that the data is stored together (the DB is local; boundary B1 from Phase 1 holds). It is that a READ performed in one client's context returns another client's content. Scoping is a read-time filter problem, and the filter must hold on EVERY read path, not just search.

### Two failure classes the design must close

1. **Non-resolution:** the surface cannot determine the active scope. Handled by the fail-closed rule (section 3): degrade to the `global` tier.
2. **Mis-resolution:** the surface derives the WRONG scope and confidently serves another client's data. Fail-closed does not help here; the derivation mechanism itself must make mis-resolution impossible by construction (section 3). This class is what disqualifies content-scan heuristics as the primary mechanism.

### Non-goals

- **Multi-user auth is out of scope.** There is no per-user identity or login. Scoping partitions one operator's own corpus by project/client; it is not a permission system. (NLM #79 tracks multi-tenant-within-one-DB separately.)
- **Deployed-client isolation is already solved by construction.** Under Option C a deployed client is a separate install, so cross-client isolation there is boundary B3, handled by physical separation, not by this scope column. This design is for the operator's central box only.
- **Cross-install aggregation / scrub-and-consent** (Phase 3) is out of scope, gated on the benchmark-moat feature being real.
- **Egress control** (which cloud APIs see content) shipped in Phase 1 and is orthogonal.
- **Operator-facing observability and whole-corpus export** (live UI feeds, dataset/backup) are declared out of scope with rationale in section 5: the operator owns all scopes; those surfaces never feed agent contexts.

---

## 2. Scope model

### What a scope IS

A scope is a stable string key identifying one project/client boundary. Proposal:

- **The stored key is the normalized project root path** (the `projectDir`/`cwd` the adapter already sees). Zero new derivation, deterministic, and available on every `SessionChunk` today. Normalization: absolute, symlink-resolved, trailing-slash-stripped.
- **An optional operator alias map** at `~/.nlm/scopes.json` maps path prefixes to a friendly scope name and, importantly, collapses several roots (git worktrees, a monorepo's sub-packages, a client's multiple repos) into one scope. Shape:
  ```json
  {
    "scopes": [
      { "name": "client-a", "paths": ["<abs path>", "<abs worktree path>"] },
      { "name": "client-b", "paths": ["<abs path>"] }
    ],
    "global": ["<operator personal workspace abs path>"]
  }
  ```
  When a path matches no alias entry, its scope is the normalized path itself (still isolated, just unnamed). When it matches a `global` entry, its scope is the reserved value `global` (see below).

**Match semantics (pinned, leak-relevant).** `deriveScope(path, aliasMap)` resolves as follows:
1. Normalize the input path (absolute, symlinks resolved, trailing slash stripped).
2. Collect every alias entry (named scopes AND global roots) whose path is the input path exactly or a prefix of it ON A SEGMENT BOUNDARY (`/a/b` matches `/a/b/c`, never `/a/bc`).
3. **Longest match wins.** Among all matching entries, the one with the longest path takes it.
4. **On equal length, a named scope beats a global entry.** Consequence: a client path nested UNDER a broad global root resolves to the client scope, never to `global`. A global root can never silently capture client work that has its own (longer or equal) entry.
5. No match: the scope is the normalized path itself. Empty/relative/unresolvable input: `null` (caller treats as cannot-derive).

Storing the path in a local column is not an egress risk: `transcript_path` already stores paths, and the DB never leaves the machine. The risk this design addresses is read-time commingling, not path-at-rest.

### The `global` tier

One reserved scope value, `global`, marks rows that are safe to surface in ANY context: the operator's own general knowledge, generic tool facts, reusable patterns with no client-proprietary content. `global` is opt-in and curated; nothing lands there automatically except rows ingested from paths the operator listed under `scopes.json.global` (and, per the match semantics above, a listed global root cannot capture a client path that has its own entry). The `global` tier is what makes fail-closed usable (section 3): an unresolved recall can safely return `global` because, by construction, `global` holds no client data.

### How each object type gets scoped at ingest

| Object | Scope source | Storage |
|---|---|---|
| **session** | `SessionChunk.projectDir` -> `deriveScope` | new `scope` column on `sessions` |
| **fact** | inherits its source session's derived scope (derive once per chunk, pass down) | denormalized `scope` column on `facts` (fast filter, no join) |
| **code exemplar** | already carries `repoPath`; same `deriveScope` | new `scope` column beside `install_scope` |
| **signal** | producer-supplied PATH in the `/api/signal` payload (the producer already holds `repoPath` before basenaming); else inherit the linked session's scope via `session_id` | new `scope` column on `signals` beside `install_scope` |
| **workstream** | stamped at creation from the first bound session's scope; binding enforces the same-scope invariant (below) | new `scope` column on `workstreams` |
| **entity** | NOT scoped (below) | unchanged |

**Signals are scoped, with no global tier.** A failure signal is always project-bound work product (it embeds repo names and failure text), so signals get a real `scope` column. Derivation must NOT use the stored `repo` field: `repo` is a logical basename by design ("never a path"), so `deriveScope(repo)` returns null per the pinned semantics and would silently stamp every signal NULL forever, starving the per-scope failure-mode block. Instead, scope stamps at ingest from one of two real anchors:
1. **A producer-supplied path.** The `/api/signal` payload gains an optional `repo_path` field; the code-signal producer already holds the full `repoPath` before it basenames, so it sends both. The daemon runs `deriveScope(repo_path)` and stamps the result, never storing the raw path beyond the derived scope value.
2. **Session inheritance.** Absent a payload path, the signal inherits the scope of the session named by its `session_id` soft link (resolved at ingest if the session row exists, else by backfill once it does).

Neither anchor available: NULL (invisible to scoped reads). **Basename-to-scope mapping is FORBIDDEN**: two clients routinely share repo basenames (`website`, `api`, `docs`), so any name-keyed bridge collides them into cross-client signal bleed. This prohibition is a review invariant, not a preference. There is no `global` signal. This is what makes the per-scope failure-mode block in section 5 actually implementable rather than a promise the schema cannot deliver.

**Workstreams get a scope column plus a same-scope-members invariant.** A workstream is stamped with the scope of the first session bound to it. Thereafter, the binder only binds a session to a workstream whose scope equals the session's scope; a session in a different scope that would otherwise match starts (or matches) a workstream in its own scope instead. **NULL semantics (pinned):** a NULL-scoped session binds with NULL-scoped workstreams; NULL equals NULL for binding purposes. This preserves pre-flip behavior exactly (with stamping off, everything is NULL and binding proceeds as today) rather than strict-equality-on-NULL killing all binding, and it is leak-safe because NULL workstreams stay invisible under scoped reads. Binder enforcement is gated on the same `NLM_SCOPE_STAMP` flag as stamping, so the invariant activates only when scopes exist to enforce. **Cross-scope rebinding is gated like merging:** BOTH `merge_workstreams` AND `rebind_session` refuse an operation that would put members of different scopes in one workstream absent the audited all-scopes flag; without gating rebind, a single rebind call recreates the mixed-scope workstream the binder invariant exists to prevent. Backfill: a legacy workstream whose member sessions are unanimously one scope inherits it; mixed-scope or underivable workstreams stay NULL (invisible to scoped reads, reachable only via all-scopes). This keeps `recall_workstream` and `list_merge_suggestions` filterable at the workstream row, with the member-session store filter as defense in depth.

### Entities stay global; the leak is closed at the session/fact level

Entities are a shared vocabulary (an entity `Postgres` is not client-specific). Scoping the entity registry is both wrong (it would fragment the vocabulary) and unnecessary. An entity-filtered recall (`recall_sessions entity=...`) is still safe because the SESSIONS returned by that filter are scope-filtered at the store. So a shared entity in scope A can never drag a scope-B session into scope-A recall. Residual accepted exposure: entity NAMES are visible across scopes (they are index terms, not content); documented in section 5. Facts, by contrast, carry proprietary VALUES, so facts ARE scoped.

### Disposition of the existing unscoped corpus (leak-first)

Every existing session/fact/exemplar/signal/workstream has `scope = NULL` after the migration. The load-bearing decision:

- **`scope IS NULL` is visible NOWHERE under scoped recall.** Not "visible everywhere." If NULL were visible everywhere, every legacy client-A row would leak into every scope-B recall, which is precisely the bug we are closing. NULL rows are reachable only via the explicit cross-scope affordance (section 6), never by default.
- **Backfill re-derives scope from stored evidence:** sessions from `transcript_path` (re-read the transcript's `cwd`); facts and exemplars inherit from their session; signals via their `session_id` join to a backfilled session (the stored `repo` basename is NEVER used, per the prohibition above); workstreams from unanimous member-session scope.
- **Rows whose evidence is gone stay NULL** and thus invisible to scoped recall. That is the safe default: under-recall, never cross-recall.

Justification under the leak-first lens: the only default that cannot leak is "unknown scope is not this scope." NULL-visible-everywhere fails that test immediately; NULL-visible-nowhere passes it, and backfill plus the `global` tier keep the usability cost bounded.

---

## 3. THE CRUX: deriving the active scope at recall time

The store can filter by scope, but each recall surface must first establish the CURRENT scope. Candidate mechanisms: (a) the surface passes cwd/project; (b) derive from the conversation (id or transcript); (c) explicit caller-supplied param; (d) hybrids.

### The governing principle (pinned)

> A scope-derivation mechanism is admissible only if MIS-resolution is impossible by construction. Fail-closed must cover mis-resolution, not just non-resolution: any mechanism that can pick the WRONG conversation, and therefore the wrong scope, is disqualified as a primary control no matter how it fails when it finds nothing.

This disqualifies content-scan heuristics as primary. `resolveConversationByQuery` scans the N most-recently-modified transcripts ACROSS ALL PROJECTS and takes the first substring match: two concurrent agents (one in client A's repo, one in client B's) issuing the same templated pull resolve to whichever transcript flushed last, and a subagent's tool_use lands in the PARENT transcript while its own cwd is a worktree. Built for telemetry, where a wrong match is harmless; as a security control it mis-attributes. It survives only as a heavily-constrained fallback (below).

### Recommended mechanism per surface

| Surface | Mechanism | Why |
|---|---|---|
| **session-start hook** | **(a) cwd** | It already receives `working_directory`; map through `deriveScope`. Present by construction, deterministic, zero round-trips. Mis-resolution impossible: the runtime states its own cwd. |
| **prompt-recall hook** (if re-enabled) | **(a) cwd** | Add a read of the payload `cwd` (present in the UserPromptSubmit event, just unread today). Same normalizer. |
| **MCP recall tools** | **(d): (c) caller-supplied conversation id resolved to THAT transcript, primary; constrained query-scan, fallback** | Detail below. |
| **HTTP `/api/recall`** | **(c) explicit `scope` param, required for scoped reads** | HTTP is the raw layer with no ambient context. The UI and any direct caller must pass `scope`. Absent -> fail closed to `global`. |
| **digest / work_summary / failure-mode** | **(a)/(c) per surface** | The failure-mode block derives from the requesting cwd (the session-start hook already passes it). Digest and work_summary are generated FOR a named scope; cross-scope requires the audited all-scopes flag. |

### The MCP mechanism in full

**Primary: caller-supplied conversation identity, resolved by ID, never by content.** Each recall tool gains an optional `conversation_id` arg (the runtime session id the agent already knows; hook-managed runtimes can inject it). Resolution: locate the transcript whose filename stem equals that id (an exact key lookup under the transcripts root, not a scan), read THAT transcript's most-recent `cwd`, and `deriveScope` it. A supplied id that matches no transcript resolves to nothing (fail closed), never to a different transcript. Stem uniqueness is verified, not assumed: copied or backup project directories can duplicate a stem, so a stem matching MORE THAN ONE file recreates a candidate set and fails closed to global-only.

**Fallback: the query scan, constrained until it cannot mis-resolve.** When no `conversation_id` is supplied and no explicit `scope` arg is given, the existing query scan may be consulted, but its result is used ONLY if BOTH hold:
1. **Exactly one** of the scanned candidate transcripts contains the query string, and
2. every location of the match within that candidate resolves to **a single scope**.

Zero matches, multiple matching transcripts, or any ambiguity: the read fails closed to global-only. Under the concurrency scenario above (two agents, same templated query), condition 1 fails and both pulls degrade to global-only rather than either receiving the other's client data. The subagent-in-worktree case degrades the same way unless the worktree is aliased (section 2), in which case parent and subagent resolve to the same named scope and the ambiguity disappears.

**Explicit `scope` arg** remains available on every tool for non-Claude-Code runtimes and for deliberate operator use; `scope: "*"` is the audited all-scopes sentinel (section 6).

Priority order per call: explicit `scope` arg > `conversation_id` resolution > constrained query-scan > global-only. The explicit arg outranks derivation because it is the only mechanism available to non-Claude-Code runtimes and the operator's deliberate lever; but it is a single-scope grant below the `"*"` sentinel, so it gets a tripwire rather than a hard block. **Scope-disagreement audit:** whenever an explicit `scope` arg is honored AND a scope is concurrently derivable from the same call (via `conversation_id` or the constrained fallback) AND the two disagree, the read still proceeds on the explicit arg but appends a `cross_scope_access.jsonl` line flagged `explicit_scope_disagreement` with both values. A stale replayed tool call carrying `scope: "client-a"` inside a client-B conversation therefore cannot read client A silently; the disagreement leaves a reviewable record (section 6).

### The FAIL-CLOSED rule (stated explicitly)

> When the active scope cannot be positively AND unambiguously derived on any surface, recall is restricted to the `global` tier only. A client/project scope is NEVER served without a positively-derived, matching active scope; ambiguity is treated as non-derivation. `scope IS NULL` legacy rows are never returned by a fail-closed read.

Why this default cannot leak: the `global` tier is opt-in and curated to contain no client-proprietary content (section 2). An unresolved or ambiguous recall therefore degrades to non-sensitive general memory, never to any client's data and never to the unclassified legacy pile. This is strictly safer than returning "nothing," because "nothing" would push toward disabling scoping, whereas "global-only" keeps the feature usable while provably leak-free.

A scoped read returns: `rows WHERE scope = <active>` UNION `rows WHERE scope = 'global'`. A fail-closed read returns only the second set. (Signals have no global tier, so a fail-closed signal read returns nothing.)

### Failure-mode analysis

- **cwd missing (session-start / hook):** scope unresolved -> global-only. A cold start with no working directory can never dump a client scope.
- **agent works across projects in one conversation:** scope is derived per call. With `conversation_id` the transcript's most-recent `cwd` tracks the project the agent is in at the moment of the pull. Residual: one call issued at the instant of a `cd` boundary may carry the just-left project's scope; scopes are disjoint, so the worst case is the previous project's memory, never a third client's. Documented, accepted.
- **MCP client is not Claude Code:** no transcript exists under the scanned root; `conversation_id` resolves to nothing and the query-scan finds nothing -> explicit `scope` arg or global-only. A non-Claude-Code pull can never surface a client scope implicitly.
- **subagent in a worktree:** covered above; aliased worktrees resolve correctly, unaliased ones fail closed or derive their own isolated scope. In no case does an unrecognized worktree surface a DIFFERENT client.
- **two concurrent agents, same query:** the constrained fallback's uniqueness condition fails; both degrade to global-only. Mis-attribution is structurally impossible on the primary path (id lookup) and condition-blocked on the fallback.

---

## 4. Enforcement point

**Recommendation: SQL-level filtering inside the stores, at a single shared choke point, not a post-filter in the service layer.**

Reasoning under the leak-first lens:

- The precedents are already SQL-level: signals filter with a mandatory `install_scope = ?` in the store, and workstreams filter with `AND s.workstream_id IN (...)` in `keywordSearch`. Scope belongs at the same layer.
- The `entity`/`kind` filter is a POST-fetch JS filter (`applyFilter` in the service). That is the wrong model for a SECURITY filter: any new recall code path that fetches rows and forgets the post-filter leaks. A store-level filter sits on the path every read already passes through: one place to get right, one place to audit.
- **Make scope non-optional in the store read signatures.** If a store method requires an `activeScope` argument (a value, or the explicit sentinel for a deliberate all-scopes read), a caller CANNOT silently omit it; omission is a compile error, not a runtime leak. Type-enforced fail-closed.
- **One `scopeClause(activeScope)` helper** builds the WHERE fragment (`(scope = ? OR scope = 'global')`, or the all-scopes form) and is reused by every read listed in section 5. A guard test (section 7) asserts every recall SQL string routes through it.

**The vector-path rule (pinned, closes the fact bypass).** Any read that goes embeddings-first and then resolves ids (`semanticSearch` -> `getByIds`) MUST re-apply scope on the resolution step, because the vector index returns neighbors from the whole corpus. Two enforcement layers, both mandatory:
1. Scope INSIDE the vector-neighbor resolution SQL: the id-resolution query joins the scoped base table and carries `scopeClause` (for facts: `getByIds` gains the non-optional `activeScope` and filters in SQL; same for the session semantic row-lookup, which already reads `workstream_id` and now also reads `scope`).
2. `makeFilterPredicate` (and any sibling JS re-filter) gains a mandatory scope check as defense in depth, so even a future unscoped fetch cannot pass the predicate.

The general rule is a review invariant: **embeddings-then-getByIds paths re-apply scope at the id-resolution step, every time, in SQL.** The hybrid-fact leak test in section 7 pins it.

**By-id reads are scope-checked (closes the stale-pointer door).** `get_session`, `/api/session/:id`, `get_fact_history`, and any other fetch-by-primary-key compare the row's scope to the active scope and REFUSE on mismatch (same not-found shape as a missing row, to avoid an existence oracle) unless the caller used the audited all-scopes affordance. Supersedence/`continues` enrichment (`getByIds(linked)`) applies the same rule: a linked session outside the active scope is omitted from the enrichment, not summarized. Old transcripts are full of pre-flip pointer ids; without this check the by-id path is an unlocked side door around every search filter.

Concretely the filter lands in: `sqlite-session-store` (`keywordSearch`, the semantic row-lookup, `listByDateRange`, `getById`/`getByIds`), `sqlite-fact-store` (`listForRecall`, `semanticSearch` resolution, `getByIds`, history reads), the code-exemplar stores, the signal store (project scope beside the existing `install_scope`), the workstream store (row filter + member listing), and the pg parity stores. The service layer passes the derived `activeScope` straight through; it does no filtering of its own.

---

## 5. Complete surface enumeration

Every corpus-returning read path in the daemon, with its disposition. Legend: **FILTER** = scope-filtered at the store per section 4; **OOS** = declared out of scope with rationale; **FC** = fail-closed derivation per section 3 feeds it.

| Surface | Returns | Disposition |
|---|---|---|
| `/api/recall` + `recall_sessions` (MCP) + both hooks | session pointers/digests | FILTER + FC (the v1 core; keyword, semantic, hybrid all inside `scopeClause`) |
| `/api/recall/facts` + `recall_facts` (MCP) | fact values | FILTER + FC, including the vector-neighbor resolution path (section 4 rule) |
| `/api/recall-code` + `recall_code` (MCP) | exemplar snippets | FILTER + FC (project `scope` beside `install_scope`) |
| `get_session` (MCP) + `/api/session/:id` | full session body | FILTER by-id check: refuse on scope mismatch absent all-scopes (section 4) |
| supersedence/continues enrichment (inside recall + get_session) | linked labels/summaries | FILTER: out-of-scope linked rows omitted (section 4) |
| `get_fact_history` (MCP) + `/api/facts/history` | full fact chain per subject | FILTER: chain rows outside the active scope omitted; empty chain if subject entirely out of scope |
| `work_summary` (MCP) + digest (`buildWorkDigest` -> `listByDateRange`) | cross-session recap | FILTER + FC: `listByDateRange` takes non-optional `activeScope`; digest is generated per scope; all-scopes digest requires the audited flag |
| `recall_workstream` (MCP) rollup | workstream + member sessions | FILTER: workstream row filtered by `workstreams.scope`; member listing passes through the scoped session store (defense in depth) |
| `list_merge_suggestions` / `merge_workstreams` / `rebind_session` (MCP) | workstream pairs, entity unions, membership moves | FILTER: suggestions pair only same-scope workstreams; cross-scope merge AND cross-scope rebind refused absent audited all-scopes |
| session-start failure-mode block (`/api/signals/failure-modes`) | failure signals incl. repo text | FILTER + FC: signals gain `scope` (stamped from producer path or session inheritance, never the repo basename); the read filters by the scope derived from the requesting cwd; no global tier for signals, so fail-closed returns nothing |
| `/api/signals/stats` | aggregate counts | FILTER (counts partition by scope; all-scopes for the operator via flag) |
| `/api/recall/stats`, `/api/recall/facts/stats`, cite-stats, precision/miss telemetry | aggregate metrics over query logs | OOS: operator telemetry; aggregates and ids, consumed by the operator's own eval tooling, never injected into agent contexts. Queries logged there were already scope-filtered at serve time. |
| `/api/recall/recent` (query log tail) | recent queries + returned ids | OOS: operator observability on a loopback-only daemon under the operator trust posture (UI auth exists but is opt-in via `nlm config ui-auth`, not enforced by default); not an agent surface. Revisit if ever exposed to agents. |
| `/api/live/recent-writes`, `/api/live/recent-markers` | ring buffer of labels/summaries/entities | OOS: local operator UI, protected by the loopback bind + operator trust posture (UI auth is opt-in, not enforced by default). The operator owns every scope; the leak model is agent-context contamination, which these never touch. Revisit if the UI ever becomes client-facing or UI auth becomes the load-bearing control. |
| `/api/dataset`, `/api/data/backup`, `/api/data/restore` | whole corpus by design | OOS: the Phase 1 export boundary (B1). Deliberate whole-DB operator actions, equivalent to copying the SQLite file. Scoping them would be security theater; the control is Phase 1's egress posture. |
| `/api/sources`, `/api/providers`, `/api/actions`, `/api/classifier/*`, `/api/health`, `/api/update-status` | config/ops metadata, no corpus content | OOS: no session/fact/exemplar content crosses these. |
| entity registry reads (names/types/counts) | entity NAMES only | OOS with documented residual: names are shared vocabulary (section 2); content behind them is filtered. Accepted exposure: a client-identifying entity NAME is visible cross-scope. |
| ingest/hook POST endpoints (`/api/ingest`, `/api/signal`, `/api/exemplar`, hook lifecycle posts) | writes, not reads | Write path: stamping per section 2; not a recall surface. |

Any FUTURE read path must land in this table (FILTER with `scopeClause`, or OOS with written rationale) before it merges; the section 7 guard test makes forgetting structurally loud.

---

## 6. Cross-scope affordances

The operator sometimes genuinely needs to search across clients (an audit, a "have I seen this pattern anywhere" query). This must be explicit and observable, never a default.

- **Surface flags:** CLI `--all-scopes`; HTTP `?scope=all`; an MCP `scope: "*"` arg. Each maps to the all-scopes sentinel that `scopeClause` recognizes and expands to "no scope restriction" (this is the ONLY way NULL-legacy rows become visible too). The same sentinel is what unlocks a by-id read of a mismatched-scope row and a cross-scope workstream merge.
- **Never implicit:** the sentinel is only ever produced by an explicit operator/agent request. No derivation path yields it. If scope cannot be derived, the result is global-only (section 3), not all-scopes.
- **Audit log:** every all-scopes read appends one line to `~/.nlm/logs/cross_scope_access.jsonl`: `{ ts, surface, query, scopesTouched, returnedIds, runtime }`. This makes deliberate cross-client access reviewable after the fact and gives the operator a tripwire if an agent starts issuing all-scopes reads unprompted. Cross-scope digests, merges, and rebinds write the same line.
- **Explicit-scope disagreement tripwire:** an explicit single-scope arg that is honored while a concurrently-derivable scope disagrees with it writes the same audit line flagged `explicit_scope_disagreement` (both values recorded). The read proceeds (the explicit arg is a legitimate lever), but a stale or replayed cross-scope arg is never silent (section 3).

---

## 7. Test strategy

The leak tests are the point of the feature; they must exist before enforcement flips on.

**Fixture shape.** A helper `seedScopedCorpus({ A: [...], B: [...], legacy: [...], global: [...] })` seeds an in-memory sqlite (temp dir, never `~/.nlm`) with disjoint sessions, facts (with embeddings), exemplars, signals, and workstreams in scopes A and B, a `scope = NULL` legacy set, and a `global` set. All modes (keyword, semantic, hybrid) are exercised against it.

**Adversarial cases that MUST pass:**

1. Recall in scope A never returns any B session/fact/exemplar, in keyword, semantic, AND hybrid modes.
2. Entity-filtered and kind-filtered recall in scope A never returns a B session (guards the post-filter bypass explicitly).
3. **Hybrid-fact vector leak:** a scope-B fact embedded as the nearest neighbor of a scope-A query is NOT returned by hybrid or semantic fact recall in scope A, even when it falls outside the keyword candidate window (the `semanticSearch` -> `getByIds` path).
4. Recall with an UNRESOLVED scope returns only `global` rows: never A, never B, never NULL.
5. `scope = NULL` legacy rows appear in NO scoped or fail-closed read; they appear ONLY under the all-scopes sentinel.
6. A shared entity present in both A and B, queried in scope A, returns only A's sessions.
7. **By-id refusal:** `get_session` / `/api/session/:id` for a scope-B id under active scope A returns the same not-found shape as a nonexistent id; with the all-scopes flag it returns the row AND writes an audit line. Supersedence enrichment omits a cross-scope linked session.
8. **Mis-resolution containment:** two transcripts (scope-A and scope-B cwds) both containing the same pull query -> the MCP fallback derives NOTHING (global-only), not either scope. A supplied `conversation_id` matching the scope-A transcript derives A regardless of the scope-B transcript's mtime.
9. All-scopes read returns A + B (+ NULL + global) AND writes exactly one `cross_scope_access.jsonl` line with the right `scopesTouched`/`returnedIds`; a normal scoped read writes none.
10. A worktree path aliased to A resolves to A; an unaliased worktree resolves to its own scope or global-only, and in neither case returns B.
11. **Nested-path precedence:** a client path nested under a listed global root resolves to the client scope (longest match wins; named beats global on ties), so client work cannot be promoted into the always-visible tier.
12. Store guard test: every recall SQL string in the session/fact/exemplar/signal/workstream stores routes through `scopeClause` (assert by construction or by scanning the prepared statements), so a future recall path cannot forget the filter.
13. Fact scope inheritance: a fact extracted from a scope-A session is stamped A and is invisible in scope B; `get_fact_history` in scope B omits it.
14. **Failure-mode block:** a scope-A failure signal never appears in a scope-B session-start block; an underivable cwd yields an empty block (signals have no global tier).
15. **Workstream invariants:** `recall_workstream` in scope A never returns a B workstream or B member sessions; `list_merge_suggestions` never pairs A with B; `merge_workstreams` AND `rebind_session` across scopes refuse without the flag and succeed-with-audit with it; a mixed-scope legacy workstream (NULL) is invisible to scoped reads; a NULL session binds with a NULL workstream (pre-flip behavior preserved) and never with a scoped one.
16. `work_summary` / digest for scope A contains no B content; `listByDateRange` compiles only with an explicit `activeScope` value or sentinel.
17. **Signal derivation prohibition:** two signals from different clients sharing a repo basename (`website`) never land in the same scope; a signal with a producer path stamps that path's scope; a signal with only a `session_id` inherits the session's scope; a signal with neither stays NULL. No code path maps a bare basename to a scope.
18. **Explicit-scope disagreement:** an explicit `scope: A` arg on a call whose `conversation_id` derives B is honored for A but writes an `explicit_scope_disagreement` audit line carrying both values; agreement writes nothing.
19. **Duplicate transcript stem:** two transcript files sharing a filename stem (copied/backup project dir) cause `conversation_id` resolution to fail closed to global-only, never to pick either file.

**Non-leak (usability) checks:** a scoped recall in A DOES return A's own rows plus `global`; backfilled sessions/signals/workstreams become visible in their derived scope.

---

## 8. Rollout

Staged, flag-gated, measured before enforcement.

1. **Migration (additive, no behavior change).** Add nullable `scope TEXT` + index to `sessions`, `facts`, the code-exemplar table, `signals`, and `workstreams`. Register the `scopes` config concept (`~/.nlm/scopes.json`, no DB table needed for v1). Mirror migration 025's shape. Postgres parity in the same wave.
2. **Ingest stamping (stamp, do not enforce).** Persist derived scope on new sessions; facts inherit; exemplars map `repoPath`; signals stamp from the producer-supplied `repo_path` payload field or inherit via `session_id` (never the `repo` basename); workstreams stamp at creation and the binder enforces same-scope (NULL binds with NULL; enforcement gated on the stamp flag). One shared `deriveScope(path, aliasMap)` with the section 2 match semantics, reused by ingest and all recall surfaces. Gate: `NLM_SCOPE_STAMP=1`.
3. **Backfill.** `nlm scope backfill` re-derives sessions from `transcript_path`, cascades to facts/exemplars, derives signals via their `session_id` join (never the `repo` basename), and assigns workstreams by unanimous member scope. Idempotent, dry-run first. Evidence-less rows stay NULL.
4. **Coverage measurement (gate before enforcement).** `nlm scope coverage` prints the stamped-vs-NULL fraction of the ACTIVE (recently-recalled) corpus per table and per surface. Enforcement flips only when coverage is high enough that fail-closed will not cripple day-to-day recall. Operator judgment, informed by the number.
5. **Flip enforcement.** `NLM_SCOPE_ENFORCE=1` activates `scopeClause` in every section 5 FILTER row and turns on per-surface derivation, including the by-id checks and the constrained MCP fallback. Default OFF until sign-off and until the coverage gate reads acceptable. The cross-scope flag + audit log ship in the same flip so the escape hatch exists the moment filtering turns on.
6. **Digest / failure-mode / workstream surfaces** move to per-scope in the same flip (their schema groundwork landed in steps 1-3, so the promise is deliverable).

Each numbered step is a task in the companion plan; steps 1-4 are safe to land behind flags before the enforcement decision, so the risky flip is isolated.

---

## 9. Open questions for Edward

1. **Unscoped-legacy disposition.** Confirm the recommendation: `scope = NULL` is invisible to scoped recall (fail-closed), shrunk by backfill, reachable only via the explicit all-scopes flag. The alternative is a one-time bulk assignment of all legacy rows to a single `legacy` scope you can opt into per session. Recommendation is invisible + backfill; your call.
2. **Scope naming and the `global` tier.** Is the stored key = the normalized project path (zero-config, with an optional alias map for friendly names and worktree collapsing) acceptable, or do you want operator-assigned names to be mandatory from day one? And what seeds `global`: only your personal workspace path, or also a curated set of generic tool/pattern facts?
3. **Do facts default global or scoped?** The design scopes facts by inheriting the source session's scope, which is the safe default. But some of your facts are genuinely general (tool behavior, your own preferences) and are more useful global. Should facts stay scoped-by-default with a manual promote-to-global path (the way MEMORY.md entries mature by hand), or should certain predicates default to global?

---

## 10. Adversarial review disposition

### First pass (8 findings; verifier: F1-F4, F6-F8 CLOSED; F5 PARTIAL, superseded by N1 below)

| Finding | Verdict | What changed in v2 |
|---|---|---|
| F1 MCP derivation mis-resolves under concurrency (structural) | Accepted | Section 3 rebuilt: primary = caller-supplied `conversation_id` resolved by exact filename-stem lookup to THAT transcript's cwd; query-scan demoted to a fallback that requires exactly one matching candidate resolving to a single scope, else global-only; the mis-resolution-impossible-by-construction principle pinned; test 8. |
| F2 Fact vector path bypasses the SQL choke point | Accepted | Section 4 vector-path rule: scope inside the neighbor-resolution SQL, `getByIds` takes non-optional `activeScope`, `makeFilterPredicate` gains a mandatory scope check as defense in depth; hybrid-fact leak test 3. |
| F3 By-id reads unscoped | Accepted | Sections 4/5: `get_session`, `/api/session/:id`, fact history, and supersedence enrichment scope-check and refuse on mismatch (not-found shape, no existence oracle) absent the audited all-scopes flag; test 7. |
| F4 Unenumerated read surfaces | Accepted | Section 5 is now a complete table over every corpus-returning route (work_summary/digest, recall_workstream, merge suggestions, fact history, entity reads, live UI, dataset/backup, telemetry), each FILTER / OOS-with-rationale / fail-closed; future-path rule added. |
| F5 Failure-mode block + signals/workstreams unscoped, promise undeliverable | Accepted | Section 2: signals gain a real `scope` column derived from their existing `repo` field (backfilled, no global tier); workstreams gain `scope` + a same-scope-members binding invariant + merge refusal; section 8 rollout carries the schema so the per-scope promise is deliverable; tests 14-15. |
| F6 UI/observability routes stream corpus unscoped | Accepted as declared-OOS | Section 5: live UI feeds, query-log tail, and telemetry declared out of scope with rationale (operator-only, loopback + UI auth, never agent-facing, revisit-if-exposed); dataset/backup declared the Phase 1 export boundary. |
| F7 Global-prefix over-capture, match semantics unspecified | Accepted | Section 2 pins deriveScope: segment-boundary exact-or-longest-prefix, longest match wins, named scope beats a containing global entry; nested-client-path test 11. |
| F8 Fact caller chain missing from the plan | Accepted | Plan Task 6 now wires `FactRecallService` / `recallFactsHandler` / `/api/recall/facts` (same unresolved -> global-only rule), and new schema/backfill/surface work from F2-F5 is task-decomposed. |

### Verification pass (5 new items + 1 accuracy nit; all folded into v3)

| Item | Verdict | What changed in v3 |
|---|---|---|
| N1 Signal scope via `repo` is unimplementable (`repo` is a logical basename, soft-default "unknown"); basename bridging would collide clients sharing repo names | Accepted (the blocker) | Section 2 signal derivation rebuilt: stamp at ingest from a producer-supplied `repo_path` payload field (the producer already holds it pre-basename) or inherit the linked session's scope via the `session_id` soft link; backfill via the `session_id` join; explicit prohibition pinned: basename-to-scope mapping is FORBIDDEN; section 0 grounding corrected; test 17. |
| N2 Explicit single-scope arg has no tripwire below the `"*"` sentinel (stale replayed arg reads another client silently) | Accepted | Priority order kept (the explicit arg is the non-Claude-Code and operator lever) but sections 3/6 add the disagreement tripwire: an honored explicit scope that disagrees with the concurrently-derivable scope writes an `explicit_scope_disagreement` audit line with both values; test 18. |
| N3 Transcript filename-stem uniqueness assumed; copies/backups recreate a candidate set | Accepted | Section 3 primary mechanism now verifies uniqueness: a stem matching more than one file fails closed to global-only; mirrored in plan Task 6; test 19. |
| N4 Binder same-scope rule undefined for NULL; strict equality would kill all binding pre-flip | Accepted | Section 2 pins NULL-binds-with-NULL (preserves pre-flip behavior; NULL workstreams stay invisible under scoped reads) and gates binder enforcement on the stamp flag; test 15 extended. |
| N5 `rebind_session` can recreate mixed-scope workstreams; only merge was gated | Accepted | Sections 2/5/6: cross-scope rebind refused absent the audited all-scopes sentinel, same rule and same audit line as merge; test 15 extended. |
| F6 nit: OOS rationale implied UI auth is enforced | Accepted | Section 5 reworded: the live-UI/query-log OOS rationale now rests on the loopback bind + operator trust posture, noting UI auth is opt-in (`nlm config ui-auth`), not enforced by default. |
