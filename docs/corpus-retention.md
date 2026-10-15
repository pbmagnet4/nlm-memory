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

## Size audit and retention proposal (2026-10-15, proposal only)

Measured read-only on the live store (`dbstat`, 4 KiB pages; 22,184 sessions, 69,368 facts of which 38,488 are active). Nothing below has been implemented.

### What dominates the 1.77 GB database

| Object | Size | Share |
|---|---|---|
| `session_embedding_chunks` vectors (106,342 chunks, 768-d float) | 518 MB | 29% |
| `sessions` table (body text 452 MB, summaries ~5 MB) | 487 MB | 27% |
| `fact_embeddings` vectors (38,411, active facts only) | 286 MB | 16% |
| `sessions_fts_data` (full-text index of body) | 265 MB | 15% |
| `facts` + all other tables and indexes | ~215 MB | 12% |

Free pages are negligible (126 pages), so `VACUUM` will not help. Fact embeddings are already clean: no superseded or retired fact keeps an embedding.

### Cohorts inside the session text

| Cohort | Sessions | Body | Chunks |
|---|---|---|---|
| `claude-code` main sessions | 8,430 | 224 MB | (shared) |
| `cc_sub_*` subagent fragments | 7,814 | 114 MB | 27,433 (26%) |
| `hermes` + `hermes-agent` | 1,404 | 80 MB | (shared) |
| `muse`, `codex`, `opencode`, `pi` | 4,532 | 34 MB | (shared) |

Every session row carries a `transcript_path`, so bodies are recoverable from the source transcript while it exists on disk. Estimated cost of the `cc_sub_*` cohort: 114 MB body + ~67 MB FTS (FTS is ~0.59x body) + ~134 MB chunks (26% of the vector table) = about 315 MB, roughly 18% of the file. Of those, 5,092 sessions (66 MB body) are older than 60 days, and 2,505 are under 8 KB.

Outside the database, `~/.nlm` holds five `canonical.sqlite.bak-*` snapshots totalling about 7.3 GB, four times the live file.

### Proposal

1. **Prune old backups (zero risk to recall).** Keep the newest one or two verified snapshots, remove the rest. Saves about 5 GB on disk and none of the live DB. Do this first.
2. **Archive cold `cc_sub_*` bodies.** For `cc_sub_*` sessions older than 60 days that were never cited, null `body` and delete their chunks and FTS rows, keeping label, summary, entities, facts and `transcript_path`. Expected live-DB saving about 150 to 200 MB (body 66 MB plus proportional FTS and chunks). Facts extracted from them stay searchable.
3. **Do not touch** main-session bodies or fact embeddings: they are the recall lane that earns citations, and the next cuts would hurt quality for little space.
4. **Optional later:** store chunk vectors as int8 or binary-quantised (vec0 supports both) for roughly 4x to 32x on the 518 MB table; this needs a recall-quality A/B before adoption.

### Risks

- Nulling a body removes it from FTS and chunk recall; the summary and facts are the only remaining hits. Mitigation: archive only never-cited sessions, and verify `transcript_path` exists before nulling.
- Triggers `sessions_au` and `sessions_ad` rewrite FTS per row, so run the archive in batches, daemon stopped or off-hours, after a verified backup.
- Whether cc_sub sessions are ever cited was not measured here (the citation log is JSONL, not a table); count that before choosing the cut-off.
- Run `nlm doctor` afterwards to confirm the integrity checks (I7 ghost embeddings) still pass.
