# Sweep guards and the destructive-path inventory

Bulk maintenance sweeps share one guard (`src/core/util/sweep-guard.ts`). A sweep says how many rows it would change out of the set it selects from. The guard refuses when:

- the share touched is above `NLM_SWEEP_MAX_SHARE` (default `0.8`), or
- fewer than `NLM_SWEEP_MIN_REMAINING` rows (default `1`) would be left,

unless overridden (`--override-guard` on the CLI commands and scripts, or `NLM_SWEEP_OVERRIDE=1`). Both rules bind only when the target set has at least `NLM_SWEEP_MIN_TARGET` rows (default `10`); a smaller set cannot be meaningfully "mostly swept", and the rules would otherwise block routine single-row work.

## Audit log

Every guard decision appends one JSON line to `sweep-audit.jsonl` in the NLM state dir (`~/.nlm`, or `NLM_STATE_ROOT`; `NLM_SWEEP_AUDIT_LOG` overrides the path). Fields: `ts`, `sweep`, `actor` (command or `daemon`), `mode` (`dry-run`, `applied`, `refused`), `touching`, `targetTotal`, `allowed`, `overridden`, `reason`. Dry runs are logged too, with the verdict the real run would get. The writer never throws; a write failure warns on stderr.

Daemon sweeps cannot take a flag, so a refusal there logs to stderr, deletes nothing and returns 0. Set `NLM_SWEEP_OVERRIDE=1` in the daemon environment only for a deliberate one-off.

## Inventory

Reversible means the change can be undone from data still in the store; "derived" means rebuildable by a re-embed or re-run.

| Path | What it changes | Reversible | Guard |
|---|---|---|---|
| `nlm reconcile-facts --apply` (`reconcile-facts.ts`) | Sets `retired_at` on facts contradicting an authorities file | Yes (column reset); DB backup taken first | Sweep guard (target: live facts), `--override-guard`, dry run prints verdict |
| `nlm reprocess` (`ingest/reprocess.ts`) | Re-classifies sessions, replaces their facts and entities | No (prior facts overwritten above the confidence floor) | Sweep guard (target: all sessions), `--override-guard`, `--limit`, resume state, dry run prints verdict |
| `nlm entities dedup --apply-safe` | Merges entities, retires the merged-away row, repoints links | Yes (retired row and `entity_variants` kept) | Sweep guard (target: live entities), `--override-guard`; dry run prints verdict |
| `nlm doctor --fix` (`check-invariants.ts`) | Deletes self-loop edges, resets orphan `superseded`/`replaced` status, deletes ghost fact embeddings | Edges and status: no; embeddings: derived | Ghost-embedding deletion guarded (target: fact embeddings), `--override-guard`; the other two fixes are fixed-shape repairs |
| `scripts/repair-fact-cycles.mjs` | Rewrites `superseded_by` on 2-cycle fact pairs | Yes (columns only) | Sweep guard, `--dry-run`, `--override-guard` |
| `scripts/repair-fact-embeddings.mjs` | Deletes embeddings of superseded/retired facts | Derived | Sweep guard, `--dry-run`, `--override-guard` |
| `scripts/repair-orphan-fact-embeddings.mjs` | Deletes embeddings with no backing fact | Derived | Sweep guard, `--dry-run`, `--override-guard` |
| Daemon signal retention prune (`SqliteSignalStore.pruneOlderThan`, every 6h, 90d) | Deletes old `signals` rows | No | Sweep guard (target: tenant signals); refusal returns 0 |
| Daemon exemplar repair sweep (`pruneReverted`, each scan) | Deletes exemplars with `survived = 0` and their vectors | No | Sweep guard (target: tenant exemplars) |
| Exemplar bucket cap (`applyBucketCap`, each scan) | Deletes exemplars past the per-bucket cap | No | Sweep guard, one decision for the whole cap pass |
| Exemplar `pruneOlderThan` | Deletes exemplars older than a cutoff | No | Sweep guard (no production caller yet) |
| Postgres equivalents (`pg-code-exemplar-store`, `pg-signal-store`, `applyFixOnPg`) | Same deletes on the hosted backend | No | Not guarded: the guard is SQLite-path only today |
| `nlm embed-backfill` dim-mismatch rebuild (`embed-backfill.ts`, `pg-embed-backfill.ts`) | Drops and recreates vector tables | Derived | Existing: `--dry-run` reports the mismatch, rebuild only on a lane change; whole-table by design, so a share guard does not apply |
| `nlm embed-backfill` per-session re-embed | Replaces a session's chunk vectors | Derived | `--limit`, resume state |
| `nlm reclassify-oversized` | Ingests sessions for failed oversized files; resets `adapter_state` | Additive | `--limit`, `--dry-run`; adds rows only |
| `nlm backfill-derivables` | Fills NULL persona/parent/model columns (COALESCE) | Fill-only | `--dry-run`; never overwrites a value |
| `nlm scope backfill` (`scope-backfill.ts`) | Stamps `scope` where NULL | Fill-only | `WHERE scope IS NULL`; dry run |
| `nlm supersede`, MCP `mark_superseded` | Marks one session superseded, writes an edge | Yes (edge delete) | Single-row; supersedence log |
| MCP `supersede_fact`, `supersede_exemplar` | Supersedes or retires one record | Yes | Single-row; supersedence log |
| `retire-workstream`, `merge-workstreams`, `rename-workstream`, `rebind-session` | Edits one workstream or session binding | Mostly (merge repoints entities) | Single-row; actions log with undo |
| Ingest-time supersession (`insertWithEmbedding`, fact `supersedeMany`, stale-fact replace) | Supersedes predecessors named by the new record; replaces a re-ingested session's facts | Edges kept | Per-record, bounded by the incoming payload |
| Source, provider and team-token deletes/revokes | Removes one config row | No | Single-row, authenticated admin API |
| `nlm restore`, `nlm backup` | Replaces or copies the DB file | Backup first | Existing backup step |
| `scripts/eval/*` fixtures | Deletes/updates rows in throwaway eval DBs | n/a | Run against copies, not the live store |

Guarded: 11 of the 24 paths above (the rest are single-row, fill-only, derived or additive, or Postgres).

## Adding a sweep

Call `guardSweep({ sweep, actor, targetTotal, touching, dryRun, override })` after counting and before mutating, and mutate only when `decision.mode === "applied"`. Print `formatDecision(decision)` on the dry-run path so operators see the verdict before they apply.
