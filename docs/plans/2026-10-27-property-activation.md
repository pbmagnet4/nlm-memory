# Property activation (T1130)

**Live 2026-10-27:** managed prerelease 0.21.21-property.1, schema 45, 67 catalog properties. Repository/explicit associations and filtered recall are enabled. Automatic fact/entity inference is disabled; T1142 owns that rejected lane. Source e3965f3, landed d9aeec7. All four independent review findings were fixed before cutover.

## Frozen activation protocol

Scope: canonical property associations and the property-aware writer from T1128. Keep existing ranking, providers, workstream bindings and automatic property selection unchanged. The runtime reports 0.21.20 but its installed files already contain T1029/T1032/T1036 patches (confirmed from BM25/RRF constants, telemetry fields, revert code and T1036 deployment evidence). Preserve this actual installed baseline using current audited main, rather than downgrading to the published 0.21.20 tag. The abandoned tag-isolation experiment is archived locally at refs/archive/T1130-baseline-isolation.

Before scoring or changing the live corpus:

1. Export the current canonical property registry with no guessed aliases. Validate slug/name collisions.
2. Freeze a deterministic private sample and its hashes. Review source evidence without displaying computed property predictions; freeze reference labels before scoring. Review 60 subject-based proposals, every current verified-quote proposal, 20 unresolved mixed/generic assertions, and 40 session-reference cases (half multi-property). Compare ownership for facts, relevance for sessions; boilerplate-only names do not establish meaningful session relevance.
3. Activation requires zero wrong-project fact assignments in the reviewed proposal sample, correct abstention for ambiguous/unresolved cases, and at least 95% session-reference precision. Report sample composition, denominator and annotation limits. These gates authorize only the conservative rules; no classifier property inference or automatic property selection.
4. Rehearse migration, catalog import, backfill and canaries on a consistent private database copy. Verify that attribution does not change counts, facts, lifecycle edges, source bodies or embeddings. Include negative property/tenant canaries and unknown-property errors.
5. Pass typecheck, relevant tests, complete release tests/build/pack checks, independent review and release provenance checks.
6. Stop the old writer, create/verify a consistent rollback snapshot and configuration backup, install the property-aware writer, then import/apply the reviewed attribution. Keep the old binary and pre-attribution database together for rollback; an old writer must not run against assigned facts.
7. Enable deterministic attribution only after the gates pass. Verify health, explicit property recall and actual ingestion. Record counts and rollback paths; leave broader inference and automatic property selection gated.

Sampling labels are private operational evidence, not public fixtures. The current agent annotates blinded source evidence before matcher scoring; this is not an independent human or inter-rater study. Small stratified samples establish a conservative release gate, not a fleet-wide precision guarantee.

## Gate failure and revised lane (before holdout scoring)

The original subject-only lane failed the zero-wrong-project gate: private case f033 assigns a NxtOS development-server port to NxtMCP based only on a mislabeled fact subject. Source review of the initial quote cases also identified runtime-directory and reverse-DNS fragments as false ownership signals. This is a rejection of that lane, not a precision estimate from a partial sample.

Revised automatic fact lane: verified literal quote, exactly one standalone canonical property name, and no disagreement with an exact subject owner. No subject-only attribution; no path/identifier/hostname-fragment attribution. Operator corrections and explicit assignments remain supported. Before scoring the revision, create a new seeded holdout from verified-quote facts excluding all original sample source assertions. Review every proposed association in that frozen holdout and all remaining ambiguous cases; report small-sample/census limits. Keep the original 40 session-reference cases and their 95% reference-precision threshold unchanged.

## Revised quote lane rejected; bounded live activation

The frozen quote holdout also failed: q026 and q073 name NxtMCP as a dependency of the NxtOS desktop application. The matcher assigns NxtMCP ownership to NxtOS packaging/UI requirements. Reference labels were frozen before predictions were read (private reference digest c0d7ed9e7c72cf0866f1dbb7963065500fd734d3917ee477c3fbdf943f43cc1b). This rejects the lane; the remaining holdout was not fully annotated, so no precision claim is made.

Session case s032 is an NLM evaluation-labeling task. Its input quotes ADHD Care Connect sessions; the matcher incorrectly assigns ADHD Care Connect relevance. This is a decisive rejection case, not a completed 40-case precision estimate. The original 95% gate has not passed.

Activate the property-aware writer, canonical catalog, explicit associations/corrections and repository-origin session references only. NLM_PROPERTY_ASSOCIATIONS=1 enables repository attribution and unresolved-fact isolation. NLM_PROPERTY_INFERENCE remains unset/0: no subject/quote fact inference, no entity-name session inference, and inference backfill refuses to run. Reviewed source-specific corrections can be applied individually. Revisit inference in a separate task with owner/dependency and quoted-transcript negatives; do not silently reinterpret this rejected study as a passing gate.

## Rehearsal and release checks

A consistent schema-44 snapshot (24,519 sessions, 72,944 facts) migrated to schema 45. Imported all 67 properties and applied six reviewed, evidence-bound fact corrections across five source sessions. Full ordered digests of sessions, facts excluding attribution columns, session edges, session embedding row IDs/vector chunks and fact embedding row IDs/vector chunks were unchanged. Quick-check passed; unknown-property and foreign-tenant canaries passed; inference backfill refused as intended. Private artifacts: ~/.nlm/evaluations/T1130/.

The first complete release run passed 3,347 tests and failed five: four stale PostgreSQL schema expectations (39 instead of the now-applied 40/41), plus the serial 4,100-vector fixture's 20-second timeout. Updated explicit migration expectations and allowed that fixture 60 seconds without changing its isolation/top-k assertions. The repo has no .agent-quality.yml or nxtgit test gate; release checks run directly.

Final complete release run: 3,352 passed, three opt-in skips across 386 files (385 passed, one skipped), with PostgreSQL enabled and two workers. Typecheck, server/UI/hook build and packed Codex release contract passed. The staged managed artifact uses unchanged production dependency definitions and the active Node v22.23.1/native modules; SQLite/vector smoke checks passed. Independent task review remains required before switching current.

Independent Muse review 2e54d999 returned four verified findings: disabled inference preserved prior automatic tags; SQLite/PG backfill hid removals; session evidence used unrelated slug substrings. Fixed all four with fail-closed re-ingestion, attribution-removal/provenance previews in both adapters, matched-entity source excerpts and regressions. These findings do not affect live data: activation has not yet occurred.

After review fixes: 44 focused SQLite/PG/property tests passed; the complete release suite passed 3,355 tests with three opt-in skips. Typecheck, build and packed-plugin contract passed again. The final snapshot rehearsal again preserved all ordered corpus/lifecycle/vector digests with 67 properties and six operator corrections. All four review findings were accepted and resolved; no review finding is deferred to activation. T1142 tracks the separate unvalidated inference capability.

## Live activation results

Activated at 2026-10-27 17:18:57 UTC using the checksum-verified local managed artifact, not a public npm release. Source commit e3965f3ca875340edabf339e4964713da9dfae87 landed as d9aeec786a8308de0d50f72e67568321a44d0089. Artifact integrity: `sha512-Z5CpkDgNvn9WHZCbNVU0W2jvJZDycwdaxhOSW7y0/yy5dYAdxlLdjFqld8pPYlg3YCcR+vlR6mRR6ulKH/wx5w==`. The current symlink points to `~/.local/share/nxt/os/nlm/versions/0.21.21-property.1`; Node remains v22.23.1.

The old launchd writer was booted out and no installed CLI/writer remained before taking the final consistent backup. Rollback set: `~/.nlm/backups/T1130-2026-10-27T17-18-47-602Z/` contains the schema-44 database, .env, config.toml and LaunchAgent plist. Quick-check passed. The previous 0.21.20 runtime remains intact. Rollback must restore database/configuration and binary together with the writer stopped; do not start the old writer against the attributed schema-45 database.

After healthy startup, atomically imported 67 canonical properties with no guessed aliases and applied six reviewed assertion-specific operator corrections and five explicit session associations. A targeted repository-origin association used NLM's own Muse adapter to read a real captured workspace, resolved its current Git identity, and added one NxtSEO session reference. Source and fact digests for that session were unchanged. This was a targeted origin backfill, not a claim of corpus-wide origin coverage.

Live verification passed 13 HTTP/MCP-schema checks plus three actual MCP calls: positive property recall, cross-property exclusion and unknown-property rejection. Prose/code embedding lanes report healthy; launchd reports running; live SQLite quick-check passed. One real session was ingested/updated after cutover, and automatic fact attribution remained zero. Final observation: 72,948 facts, of which six have operator attribution; five operator and one repository session associations. All other facts remain unresolved. These counts are a point-in-time observation, not steady-state corpus totals.

Provider .env content excluding the two property flags and config.toml were verified unchanged against the final backup. `NLM_PROPERTY_ASSOCIATIONS=1`, `NLM_PROPERTY_INFERENCE=0`. No inference backfill ran and no dummy session was inserted. Missing historical worktree paths abstain; they cannot be recovered from a branch-name guess.

Private evidence is under `~/.nlm/evaluations/T1130/`: snapshot/sample manifests and rejection labels, rehearsal-report.json, cutover.json, live-associations.json, live-repository-canary.json, live-canaries.json, live-mcp-calls.json and final-observation.json. Independent code/security review: `~/.nxtos/logs/landing-reviews/2e54d999.json`; four findings accepted and fixed. Full final release checks: 3,355 passed, three opt-in skips; typecheck, build and packed-plugin contract passed.
