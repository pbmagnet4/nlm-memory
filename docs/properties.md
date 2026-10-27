# Canonical memory properties

**Unreleased source:** these features are in the 0.21.21-rc.1 source candidate, not the stable npm 0.21.20 package. See [release status](release-status.md).

A property identifies the project a memory concerns. Properties are tenant-scoped and separate from workstreams and directory scopes. Directory scope is not an authorization boundary; tenant checks remain mandatory.

## Catalog

`nlm properties import <file.json>` merges a reviewed catalog into the current tenant. The JSON is an array:

```json
[{"slug":"example-app","label":"Example App","aliases":["Example"],"repositories":["/projects/example-app"]}]
```

Slugs are stable identifiers. Imports update labels, aliases and repository paths for existing slugs. Imports reject alias collisions and do not delete properties or rewrite existing attribution. Multiple host paths can identify the same repository. A task worktree matches through its common Git directory. A captured directory that cannot be resolved locally falls back to path-prefix matching. When the captured directory has a known Git identity, a catalog path without that identity abstains; an independent nested repository must not inherit its parent directory's property. Ambiguous matches abstain.

Keep the catalog generated from the installation's existing project registry. NLM has no dependency on Whtnxt YAML or any particular registry service.

## Attribution and corrections

Set `NLM_PROPERTY_ASSOCIATIONS=1` to enable property-aware ingestion and repository-origin session associations. Explicit corrections and session associations work regardless of this flag. Automatic fact inference and entity-name session associations require the separate experimental `NLM_PROPERTY_INFERENCE=1`, which must remain off in production: source evaluation found dependency/owner confusion and references copied from evaluation transcripts. Origin is relevance evidence, not fact ownership. `nlm properties associate-session <sessionId> [slugs...]` sets explicit session associations; an empty list clears explicit associations only.

The experimental matcher proposes one assertion context from a verified source quote naming exactly one catalog display name or explicit alias, consistent with any exact subject alias. A subject label alone is insufficient. Runtime paths, code identifiers and reverse-DNS namespace fragments are not property names. Missing, stale or comparative evidence remains unresolved. Session references never propagate ownership to all its facts. Stored fact attribution includes the slug, source and supporting evidence.

`nlm properties correct <factId> <slug>` corrects a fact. `nlm properties correct <factId> --clear` rejects its attribution. Corrections bind to the tenant, runtime session identity and a digest of normalized kind/subject/predicate/value and source quote. Facts without quotes also bind to the source body version. They survive changed fact IDs and whitespace-only changes. Missing runtime IDs fall back to the source session ID. Changed assertions, changed quotes or changed unquoted source versions are reported by `nlm properties pending`; duplicate indistinguishable assertions refuse correction. Corrections remain stored when their original fact disappears.

Attribution precedes ingestion's collapse. Automatic supersession, batch winners, history, the write-time judge and corroboration respect assertion context. In the opt-in path, unresolved facts do not automatically collapse other facts. With the flag off, legacy unassigned ingestion keeps its prior behavior; assigned facts remain isolated, and stored corrections still apply.

## Recall

`recall_sessions`, `recall_facts`, `recall_context`, and `get_fact_history` accept a canonical `property` slug. CLI session recall accepts `--property <slug>`. HTTP `/api/recall`, `/api/recall/facts`, and `/api/facts/history` accept `property` as a query parameter. Unknown properties return an error. Workstream and property constraints intersect.

Both keyword and semantic retrieval apply property eligibility before their result limit. Property-specific exact context lookup counts only eligible assertions. Cross-property context responses keep facts from different assertion contexts separate. Session filtering establishes relevance; a mixed session's transcript can still discuss other properties within the same tenant. Existing known-fact enrichment preserves and displays property labels. This does not automatically select a property. Optional unfiltered enrichments are omitted from property-filtered session recall.

## Backfill and evaluation

With the experimental inference flag enabled, `nlm properties backfill` previews fact and session-reference associations; `--apply` writes them. It previews removals as well as assignments, clears rejected automatic attribution on apply, preserves explicit/operator corrections and leaves lifecycle/history untouched. Run `nlm properties pending` afterward. Previously incorrect supersession needs a separately reviewed repair; attribution does not revive historical facts.

The read-only SQLite coverage tool is `npx tsx scripts/eval/property-association-coverage.ts <database> <catalog> --tenant <id>`. It neither migrates nor modifies the database and reports coverage, not precision. PostgreSQL behavior is covered by the shared property-memory contract.

Classifier inference and automatic property-based hook injection are not enabled by this change. Independently label real single-property, mixed, orchestrator, worktree and ambiguous cases, freeze thresholds before tuning, and evaluate against those labels before enabling a broader inference lane.

The initial live activation uses repository origin and explicit associations only. Neither exact subjects nor verified name-bearing quotes establish reliable fact ownership. Disabling inference strips automatic tags during re-ingestion while preserving explicit/operator assignments. Existing memories remain unresolved until individually reviewed; corpus-wide inference backfill is blocked by default. See [evaluation status](evaluations.md).
