# Property activation (T1130)

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
