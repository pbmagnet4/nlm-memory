# Corpus Retention and Consolidation

NLM does not silently decay or delete memory. Retention is staged: instrument first, consolidate second, compact last (and only behind a measured gate). This page covers the shipped pieces: the corpus monitor and the entity dedup runbook.

## Corpus monitor

A daily daemon job (SQLite backend) computes corpus statistics and appends one JSON line to `corpus-stats.jsonl` in the data directory: db bytes, session count, body bytes, capped bodies, entity counts (total and single-session), fact counts (active / superseded / retired), markers, and code exemplars.

- `/api/health` includes the latest snapshot under `corpus` (null until the first run, which happens about a minute after daemon start and then every 24h). `nlm health` prints the same.
- Size thresholds drive the `state` field: `ok`, `warn` (default 1GB), `alert` (default 2GB). Override with `NLM_CORPUS_WARN_BYTES` / `NLM_CORPUS_ALERT_BYTES`. Warn and alert states also log to the daemon's stderr.
- The same job appends a weekly re-derivation datapoint to `re-derivation-trend.jsonl` (`rate`, `pairCount`, `eligible`, `windowDays: 42`). This trend is the safety gate for any future destructive compaction: compaction is considered only when the trend is flat with weeks of baseline, size pressure is real, and the operator signs off.

## Entity dedup

Entities accumulate near-duplicate surface forms over time (case variants, punctuation variants, plural forms, repo-suffix twins). Duplicates dilute recall filters and entity statistics. The merge primitive consolidates them canonically:

- `session_entities` links move to the surviving entity (deduplicated), its `session_count` is recomputed exactly, and its first/last-seen span widens to cover both.
- The merged-away name is recorded in `entity_variants`, so future ingest binds that surface form straight to the survivor. The old row is kept with `status='retired'` (nothing is deleted; history stays intact).

Runbook:

```
nlm entities dedup                # dry run: prints safe and likely merge pairs
nlm entities dedup --apply-safe   # executes safe-class merges (fold-identical names)
nlm entities dedup --interactive  # y/n adjudication for likely-class pairs
```

- `safe` pairs are identical after case, space, hyphen, underscore, and dot folding; auto-applying them is not a judgment call.
- `likely` pairs (singular/plural, `-ts`/`-js`-style repo suffixes) always require a human yes.
- Suggestions are deliberately lexical-only. Embedding similarity over-merges adjacent-but-different entities, so it is excluded by design.

Run the dry run first, always. Merges are transactional per pair; a failed pair is reported and skipped, never half-applied.
