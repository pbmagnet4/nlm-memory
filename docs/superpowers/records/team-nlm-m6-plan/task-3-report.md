# Task 3 report — flip leak-contract case 12 + pg twin

## What changed

`tests/integration/tenant-leak-contract.test.ts`: replaced the case-12
`it.todo` with a real assertion body covering, in order:

1. **Memo isolation** — `recordSurfaced(A, convId, [sess_a_only])` then
   `loadSurfaced(B, convId)` is empty; `loadSurfaced(A, convId)` still holds
   the row. (`core/hook/memo.ts`)
2. **Query log** — A and B each `logQuery` one distinct entry; each
   tenant's `readQueryLog`/`recallStats` output contains only its own
   entry; the `DEFAULT_TEAM_ID` ("legacy") file — routed at a temp path via
   `NLM_QUERY_LOG` so the test never touches the real
   `~/.nlm/query_log.jsonl` — receives neither tenant's row (raw-content
   `not.toContain` check). (`core/recall/query-log.ts`)
3. **Citation log** — same shape via `appendCitation`/`readCitationLog`/
   `citationStats`. Conversation ids are non-`test`-prefixed so
   `isAttributableConversationId` doesn't drop them at the source.
   (`core/recall/citation-log.ts`)
4. **Miss log** — same shape via `appendMiss`/`missStats`.
   (`core/recall/miss-log.ts`)
5. **Hook log** — `appendHookLog` has no dedicated reader export, so
   isolation is asserted by reading the derived-path file's raw content
   directly (mirrors `tests/unit/core/hook/hook-log.test.ts`'s own
   path-contract style). (`core/hook/hook-log.ts`)
6. **HTTP level** — `GET /api/recall/stats` under `NLM_HOSTED=1` with a
   `TeamTokenStore`-minted Bearer token per tenant (the case-8 pattern)
   reflects only that tenant's write; no `queryLogPath` override on
   `createApp`, so the route reads the same real tenant-derived file the
   direct `logQuery` calls above wrote.
7. **Amendment — supersedence audit log** — `appendSupersedence` as A then
   `readSupersedenceLog` as B returns `[]`; A's own read contains the
   entry. (`core/storage/supersedence-log.ts`)
8. **Amendment — HTTP supersede leg** — the real
   `POST /api/session/:id/supersede` route invoked as token-A (reusing the
   fixture's actual `team_a` session ids so `markSuperseded` has real rows
   to operate on) is asserted invisible to `team_b` via a store-level
   `readSupersedenceLog("team_b")` check — the "where cheap to assert at
   the store level" scope the amendment calls for, in place of building out
   a full `get_session` enrichment round-trip (which would need a second
   fabricated session graph under a fresh tenant). The route's
   `appendSupersedence` call is fire-and-forget (not awaited by the
   handler, same pattern as case 7's ingest write), so this leg polls up to
   3s rather than racing it.

Test tenants are `team_a_case12`/`team_b_case12` — unique to this case, not
the fixture's SQL-backed `team_a`/`team_b` — so its real
`~/.nlm/tenants/<t>/` writes can't collide with any other spec file. The one
deliberate exception is the HTTP-supersede leg (item 8), which reuses the
fixture's literal `team_a`/`team_b` session data; a grep across `tests/`
confirmed no other test writes real (non-overridden) files under those
literal tenant ids, so this is safe. `team_tokens.team_id` has a live FK to
`teams(id)`, so the test inserts `teams` rows for
`team_a_case12`/`team_b_case12` before minting tokens for them (the
fixture only pre-seeds `team_a`/`team_b`). All real homedir paths created
(`~/.nlm/tenants/team_a_case12/`, `~/.nlm/tenants/team_b_case12/`,
`~/.nlm/tenants/team_a/supersedence-log.jsonl`,
`~/.nlm/tenants/team_b/supersedence-log.jsonl`) are removed in a `finally`
block, along with the four env var overrides
(`NLM_QUERY_LOG`/`NLM_CITATION_LOG`/`NLM_MISS_LOG`/`NLM_HOOK_LOG`) and
`NLM_HOSTED`. Verified post-run: `~/.nlm/tenants/team_a` and `team_b` do
not exist on disk.

## Header-comment verification

Confirmed by reading `tests/integration/tenant-leak-contract.pg.test.ts`:
case 10 (concurrency) is **not** pending — it already landed as a real test
there (`it("case 10: concurrent tenants (pg) ...")`) on M7's
`usePgTestSchema` isolated-schema harness. The sqlite file's old header
claimed "case 10 is concurrency and lands with M7's harness" (present
tense, implying future) and "case 10 (concurrency) stays out of scope for
both files per the plan" — both stale; the pg file already has it. Rewrote
both files' headers:

- Sqlite file: case 10 doesn't apply to sqlite's single-writer model at
  all (not "pending" — genuinely out of scope for this lane specifically,
  clarified as such); states plainly that every case enumerated in this
  file (1-9, 11, 12) is now real, none `it.todo`.
- Pg file: notes case 12 is deliberately not duplicated and why (see pg
  twin decision below), pointing at the sqlite file for the real
  assertions.

## Pg-twin decision

**No duplicate test added.** The file-state modules under test (memo,
hook-log, query-log, citation-log, miss-log, supersedence-log) are plain
Node `fs`/`fs/promises` JSONL/JSON writers keyed only by `tenantId` string
via `tenantStatePath()` — the sqlite-vs-pg storage backend never enters
their code path at all. A pg-lane copy of case 12 would exercise the exact
same `core/hook/memo.ts` etc. functions against the exact same real
filesystem, asserting nothing a pg `Pool` or `PgSessionStore` could ever
cause to differ. Replaced the pg file's `it.todo` with a one-line pointer
comment instead, per the brief's explicit permission for this shape of
case.

## Test evidence

- `npx tsc --noEmit` — clean, no errors.
- `npx vitest run tests/integration/tenant-leak-contract.test.ts` — **13
  passed** (12 pre-existing + the new case 12).
- `npx vitest run tests/integration/tenant-leak-contract.pg.test.ts` — 10
  skipped cleanly (`describe.skipIf`); the file-level connection attempt to
  `NLM_PG_TEST_URL` (`127.0.0.1:54329`) fails with `ECONNREFUSED` — no pg
  instance running in this environment. Pre-existing condition, unrelated
  to this change (case 12 was never in this file's live test count).
- Full suite tail (`npx vitest run`): **264 files passed, 27 files failed
  (2275 tests passed, 7 tests failed, 228 skipped)**. All 27 failed files
  and all 7 failed tests trace to the same root cause —
  `ECONNREFUSED 127.0.0.1:54329` against `NLM_PG_TEST_URL` — matching the
  brief's stated baseline of 7 pre-existing pg-connectivity failures
  exactly. None are in `tenant-leak-contract.test.ts` or
  `tenant-leak-contract.pg.test.ts`.

## Concerns

None outstanding. The one design call worth flagging: item 8's HTTP-leg
assertion checks invisibility via a direct `readSupersedenceLog("team_b")`
store-level read rather than round-tripping through `get_session`'s
enrichment path (which reads the same function internally) — this is the
scope the amendment's parenthetical explicitly calls for ("where cheap to
assert at the store level"), and building the full `get_session` path would
have required fabricating a second session graph under a fresh tenant for
no additional coverage, since `getSessionHandler`'s enrichment fencing
(program spec §4.6 hardening 2) is exercised by case 9 already.

## Final-review fix wave

The M6 final review approved the engineering but blocked the milestone on
six findings. Fixed all six; five commits, `546682a`..`cb3d467`.

### 1. Tenant-id collision guard (`fix(tenancy)` `546682a`)

`sanitizeTenantId` (`src/core/tenancy/tenant-state-path.ts`) was lossy:
`acme.co` and `acme_co` both sanitized to `acme_co`, colliding their state
dirs. Per the reviewer's suggestion: an id already matching
`/^[A-Za-z0-9_-]+$/` is used as-is (existing safe ids like `acme`,
`tenant-a`, `team_a_case12` are byte-identical to before — zero behavior
change for every real caller); any other id gets its sanitized form plus an
8-hex-char sha256 digest of the *raw* (pre-sanitization) id appended, so two
ids that collide after sanitization always land in distinct directories
(deterministic, not random). Extended `tests/unit/core/tenancy/tenant-state-path.test.ts`:
the traversal case (`../../etc/passwd`) and empty-id case now assert the
hashed form; two new cases assert `acme.co` vs `acme_co` (and `acme.co` vs
`acme:co`) derive different, non-colliding dirs.

### 2 + 3. Destructive test cleanup + `NLM_STATE_ROOT` seam (`546682a`, `38f9d4a`, `4525986`)

Added `NLM_STATE_ROOT` to `tenantStatePath` (same commit as finding 1): an
env override for the `~/.nlm` base directory, honored by both the
default-team and non-default-team branches (they share one `base`
computation), test-only, unset in production. Doc comment states explicitly
that this is a root move, not a per-tenant redirect — it does not
reintroduce the leak the per-file overrides (`NLM_QUERY_LOG` et al., which
apply to the default team's file only) were scoped away from, because every
tenant's directory moves together under the new root.

Pointed every tenant-path test that previously wrote directly under the
real `homedir()` at this seam instead (`38f9d4a`): `memo.test.ts`,
`hook-log.test.ts`, `query-log-tenant-path.test.ts`, `citation-log.test.ts`,
`miss-log.test.ts`, `hook-recall-log.test.ts`, `recent-log-tenant-path.test.ts`,
`fact-query-log-tenant-path.test.ts`, `supersedence-log.test.ts`,
`cite-memo.test.ts`, plus one case in `sqlite-outcome-store.test.ts`
(`SqliteOutcomeCitationReader` cross-tenant test) — 11 files, ~27 cases
total that used to leave residual `~/.nlm/tenants/<t>/` directories behind
(the review found 30; `rm`ing only the leaf file, never the parent dir, was
the mechanism). Dropped the now-dead per-test `rmSync`/try-finally cleanup
blocks that existed solely to mop up those real-homedir writes.

Case 12 in `tenant-leak-contract.test.ts` (`4525986`) gets the same
treatment: `NLM_STATE_ROOT` set to the fixture's own temp dir for the whole
test, so `derivedA`/`derivedB`/`supersedeDirA`/`supersedeDirB` (previously
`join(homedir(), ".nlm", "tenants", ...)`) now resolve under the fixture
dir and get swept by the fixture's own `afterEach`. The task-3 report above
(pre-existing, before this fix wave) claimed "`~/.nlm/tenants/team_a` and
`team_b` do not exist on disk" post-run — that was true in isolation but
went stale the moment case 8 (below) ran in the same suite.

**Additional discovery while verifying the "zero new dirs" gate**: case 8
(token-swap, pre-existing, not part of M6 Tasks 1-4) issues real
`GET /api/recall` requests against `token-team-a-case8`/`token-team-b-case8`,
which resolve to the fixture's literal `team_a`/`team_b` tenant ids. Its
`createApp` call has no `queryLogPath` override, so `query-log.ts`'s
tenant-derived default path wrote directly into the real
`~/.nlm/tenants/team_a/query_log.jsonl` and `team_b/query_log.jsonl` on
every run — confirmed by content (`query: "onboarding"`,
`returned_ids: ["session-team_a-1"]` etc., matching case 8's request
exactly) and by timestamp correlation with prior verification runs. This is
what actually caused the two "new" `team_a`/`team_b` directories I saw on
first verification pass (not present in the review's original 30). Not in
the six findings' scope, but it directly blocks the "zero new dirs" gate,
uses infrastructure I'd already built, and is a one-line fix in the same
file — wired `NLM_STATE_ROOT` (fixture's temp dir) around case 8 too.

### 4. Re-derivation pairs cache tenancy (`fix(tenancy)` `6295c0f`)

`~/.nlm/re-derivation-pairs.json` was a single shared file regardless of
tenant. `sqliteReDerivationDeps` (`src/core/metrics/re-derivation.ts`) now
takes a non-optional `tenantId` and filters its sessions SELECT via
`tenantClause` (imported from `@core/tenancy/tenant-clause.js`) — the
`listSessionsWithin` query gained ` AND tenant_id = ?` with the tenant param
bound alongside the existing window param. `loadCachedReDerivationPairs`
(`src/core/storage/sqlite-outcome-store.ts`) takes `tenantId` as its first
param, replacing the module-level `DEFAULT_REDERIVATION_PAIRS_PATH`
constant with a default parameter computed via
`tenantStatePath(tenantId, "re-derivation-pairs.json")` — default team
lands on the byte-identical legacy path, every other tenant gets its own
`tenants/<t>/re-derivation-pairs.json`. Both `buildSqliteOutcomeDeps` and
`loadOutcomeCoverageInput` (both already had `tenantId` in scope) pass it
through unchanged in call shape.

`persistReDerivationPairs` (`src/cli/nlm.ts`) gained `tenantId` as its
second param (after `rawDb`, mirroring `sqliteReDerivationDeps`'s own
shape), threaded to both `sqliteReDerivationDeps` and the pairs-cache write.
Its only production caller — the local corpus-monitor cron — passes
`DEFAULT_TEAM_ID`, consistent with every other call in that single-tenant
CLI (this cron has no per-request tenant to resolve; it is the
local-deployment operator's own background job, not a request-scoped
surface). The `nlm metrics re-derivation` CLI command's direct
`sqliteReDerivationDeps` call got the same `DEFAULT_TEAM_ID` argument for
the same reason.

Updated existing callers: `tests/integration/re-derivation.test.ts` (2
`sqliteReDerivationDeps` calls), `tests/integration/re-derivation-persist.test.ts`
(1 `persistReDerivationPairs` call), `tests/unit/cli/persist-rederivation-pairs.test.ts`
(1 `persistReDerivationPairs` call against a stub db). New test in
`sqlite-outcome-store.test.ts`: two tenants' pairs caches, both computed
with no explicit `reDerivationPairsPath` (i.e. both relying on the new
tenant-derived default), don't collide — verified under the
`NLM_STATE_ROOT` seam.

`sqliteReDerivationDeps` lives in `src/core/metrics/`, not
`src/core/storage/`, so it's outside `tenant-guard.test.ts`'s scanned file
set (`src/core/storage/*.ts` + three named files) — the literal-scan/
import-requirement guard doesn't apply to it and wasn't expected to.

### 5. Fact-stats leak assertion gap (`test(tenancy)` `4525986`)

Case 12 never asserted the fact-query-log stats surface. Added: `logFactQuery`
as `team_a_case12` and `team_b_case12` with distinct subjects, `factRecallStats`
for each reflecting only its own subject/count, and the
`GET /api/recall/facts/stats` HTTP leg reusing the case's existing
`tokenA`/`tokenB` fixtures (same pattern as the pre-existing
`/api/recall/stats` HTTP leg immediately above it) — each token's stats
response reflects only that tenant's `logFactQuery` write.

### 6. Stale comment (`fix(tenancy)` `cb3d467`)

`src/mcp/server.ts`'s `createMcpServer` doc comment said "pass
DEFAULT_TEAM_ID until M3 replaces it" — M3 landed (verified: `src/http/app.ts:731`
calls `createMcpServer(capturedMcpDeps, resolved.teamId)`, the token-resolved
team). Corrected to state the stdio caller (`src/cli/nlm.ts`, local-mode
only) always passes `DEFAULT_TEAM_ID`, and the HTTP mount passes the
token-resolved team.

### Test evidence

- `npx tsc --noEmit` — clean, no errors, checked after every source change
  and again at the end.
- Targeted covering-test runs (tenant-state-path, all 11 rewritten
  module-test files, tenant-leak-contract, tenant-guard, re-derivation x2,
  persist-rederivation-pairs, sqlite-outcome-store, re-derivation metrics
  unit) — **all passed** (130 tests across 18 files in the first targeted
  batch; reconfirmed individually after the case-8 fix).
- Full suite tail (`npm test -- --run 2>&1 | tail -10`), run twice
  (pre- and post- case-8 fix): **264 files passed, 27 files failed, 2282
  tests passed, 7 tests failed, 228 skipped**, both times. All 7 failures
  and all 27 file-level failures trace to `Error: connect ECONNREFUSED
  127.0.0.1:54329` against `NLM_PG_TEST_URL` — no Postgres instance running
  in this environment. Matches the stated baseline of 7 pre-existing
  pg-connectivity failures exactly; none touch tenancy code.
- **`~/.nlm/tenants/` before/after, full suite**: captured a baseline
  listing (32 entries — the review's original 30 residual dirs plus
  `team_a`/`team_b`, which I discovered were newly created by the
  then-unfixed case-8 leak during my own first verification pass), fixed
  case 8, then ran the full suite twice more with `ls ~/.nlm/tenants/ |
  sort` captured immediately before and after each run. Both runs:
  `diff before after` — **empty, exit 0**. Zero new directories or files
  from either run; `team_a`/`team_b`'s `query_log.jsonl` (5 lines,
  `mtime` from the earlier contaminated run) was not touched by either
  verification run, confirming the case-8 fix actually stops the write
  rather than merely reusing an already-existing directory.
  I could not `rm -rf` the pre-existing `team_a`/`team_b`/30-dir residue
  myself (destructive `rm -rf` under the real home directory is blocked by
  the sandbox's permission system) — those are cleanup Edward can run
  directly (`rm -rf ~/.nlm/tenants/{acme*,tenant-*,team_a,team_b}`) since
  none of them hold anything but test fixtures.

### Concerns

None outstanding on the six findings. One scope note: the case-8 fix
(above) is a real bug I found and fixed but that isn't one of the six named
findings — flagging it explicitly in case Edward wants it called out
separately in any downstream tracking, since it's a pre-M6 leak (the
`/api/recall` route's telemetry call, not the M6 file-state-module work)
that happened to share a file and a fix mechanism with this wave.
