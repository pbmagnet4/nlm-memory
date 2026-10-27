# Canonical memory properties (T1128)

Properties identify what an assertion concerns. Tenant identity remains authorization; directory scopes retain their existing semantics. A workstream is a thread of work, not a property identifier.

## Invariants

- A fact has one assertion context, or is unresolved. Comparative statements remain unresolved until split or corrected. A session can concern multiple properties through its facts.
- Origin repositories are catalog metadata, not blanket fact ownership. An orchestrator working directory cannot attribute every assertion to the orchestrator.
- Attribute facts before destructive lifecycle changes. Supersession and corroboration compare assertion contexts, not overlapping session tags.
- Operator corrections bind to runtime session identity plus an assertion/evidence digest, never random fact IDs. Missing quotes bind corrections to the source body version. A changed assertion leaves the correction pending. Ambiguous duplicate assertions refuse correction.
- No classifier-based property assignment or automatic injection until independent corpus evaluation passes. Literal evidence or an exact subject alias is the deterministic first lane.

## Rollout

Schema and explicit property reads are additive. `NLM_PROPERTY_ASSOCIATIONS=1` opts ingestion into deterministic attribution and disables automatic collapse of unresolved facts. With it unset, legacy unassigned ingestion retains its existing behavior; assigned facts always remain isolated. Import a reviewed catalog, inspect a dry-run backfill, apply only after reviewing it, and use explicit property recall before changing hook defaults.

A backfill changes attribution only. It does not revive previously superseded facts or rewrite history. Historical erroneous supersession requires a separate reviewed repair.

Before automatic injection, independently label real single-property, mixed-property, orchestrator, worktree, missing-evidence and ambiguous-alias sessions. Freeze the sample and acceptance thresholds before tuning. Report coverage separately from precision and unresolved cases. Synthetic tests verify mechanisms, not real-world classifier quality.

## Read-only corpus baseline (2026-10-27)

The current 67-property workspace registry has no exact normalized name collisions. Against tenant `team_local`, the read-only coverage tool measured 40,398 active facts: 680 proposed associations (668 exact subjects, 12 verified quotes), 39,718 unresolved. It found entity references in 8,846 of 24,514 sessions; 937 reference multiple properties. This is coverage only, not an independently labeled precision result. Broader inference and automatic hook selection remain gated.

The implementation includes both storage adapters, session origin/reference associations, explicit correction and backfill CLI operations, property filters on MCP/HTTP/session CLI recall, and a shared backend contract. Public behavior is documented in `docs/properties.md`.

## Review and validation

Independent Muse Spark 1.3 xhigh review of the implementation commit completed in 321 seconds with two leads. The PostgreSQL maintenance embedding lead was reproduced with a shared contract: SQLite passed and PostgreSQL lost one property's semantic hit when stored corrections applied with inference disabled. Fixed by sharing stored-attribution winner selection across ingestion, maintenance and judge paths. The repository-prefix recommendation was rejected: a known independent nested Git repository must abstain rather than inherit a non-repository parent's property. Added a regression and narrowed the documentation to the actual fail-closed fallback rule.

Direct review additionally fixed evidence-bound correction identity, property-specific session cascades, context deadline accounting and preservation of labels through existing hook formatting. Packaged hooks were regenerated from source. Broader inference and automatic property selection remain behind the independent corpus-evaluation gate.

Validation artifacts: `/private/tmp/nlm-T1128-final-tests.log`, `/private/tmp/nlm-T1128-typecheck.log`, `/private/tmp/nlm-T1128-build.log`, `/private/tmp/nlm-T1128-coverage.json`, `/private/tmp/ocr-nlm-T1128.json`. The repo has no `.agent-quality.yml`; targeted Vitest, all three TypeScript configurations, server build and existing UI build were run directly.

Final focused verification: 63 test files, 678 tests passed on SQLite and the real isolated-schema PostgreSQL lane. All TypeScript configurations and server/UI builds passed; hook bundles were regenerated and their formatter/HTTP contracts passed. The installed runtime and live corpus remain unchanged.

The required pre-land guard review completed in 303 seconds and identified missing parent-session ownership checks in both attribution adapters. Both were reproduced by calling the write boundary with a foreign tenant's valid session ID; added ownership checks and shared regression coverage. Updated the guard's census documentation as requested. Report: `/Users/echalupa/.nxtos/logs/landing-reviews/c0c0729b.json`.
