# Release and capability status

Status recorded 2026-10-27. The npm version badge and GitHub Releases show the current published stable package; source on main can be newer.

| Channel | Version | Availability |
|---|---|---|
| Published stable | 0.21.20 | `npm install -g nlm-memory`; [release](https://github.com/pbmagnet4/nlm-memory/releases/tag/v0.21.20). |
| Source candidate | 0.21.21-property.1 | Build from main. This version is not a published npm release or a stable-channel upgrade. |

## Changes in the source candidate

- Tenant-scoped canonical property catalogs; explicit fact corrections and session associations.
- Session relevance from captured repository origin, including extant Git worktrees. Missing or ambiguous origin evidence abstains.
- Property filters on session/fact/context/history recall; property-aware lifecycle and corroboration boundaries.
- Experimental quote/entity matchers behind a separate flag, off by default. Evaluation rejected their ownership/relevance accuracy. Inference backfill refuses to run unless explicitly enabled; do not enable it for production use.
- Fact-recall BM25 and reciprocal-rank-fusion changes, recency indexes, code-exemplar revert detection and usefulness telemetry. These changes do not establish a new answer-quality score.

`NLM_PROPERTY_ASSOCIATIONS=1` opts into repository association and unresolved-fact isolation. Keep `NLM_PROPERTY_INFERENCE` unset or `0`. Explicit corrections are available independently of those flags. A session's repository indicates relevance; it does not establish ownership of every fact in its transcript.

## Upgrades and downgrades

Source builds include new database migrations. Back up the database and configuration before trying them. A downgrade after applying property associations must restore the matching pre-upgrade database/configuration as well as the old binary: an older writer does not understand the new attribution boundaries.

Ordinary stable installation instructions remain on the [README](../README.md#install). Trying the synthetic demo does not migrate your real database. See [properties](properties.md) for configuration and correction semantics.
