# Corpus Retention and Consolidation (#353) - Design

Status: design complete, staged; Stage A+B build-ready (plan in docs/superpowers/plans/), Stage C parked behind a measured gate and operator sign-off.

## Measured reality (2026-07-03, read-only against the live corpus)

The 2026-06-22 audit's direction holds but its numbers and the obvious remedy do not:

- 5,350 sessions, 463MB on disk, growth ~750-870 sessions/week and rising (audit assumed ~469).
- ZERO sessions older than 180 days and only 47 older than 90 (corpus born early April). An age-TTL summarize pass, the #157 shape, would touch nothing for months. The 2GB horizon comes from growth rate, not age.
- Bodies are 171MB (~37% of the file), avg 32KB, 187 sessions truncated at the 200k ingest cap. Bodies are searched (FTS5 keyword leg) and embedded, but NEVER returned by recall; only the explicit get_session tool fetches them.
- 13,368 entities (up 49% from the audit's 8,951), every one still status=candidate/type=candidate; 53-59% hapax. entity_variants is a dead table (0 rows, no writer). The existing merge/rename/retire entity actions are OVERLAY projections consumed only by the dataset/UI layer; recall never loads the overlay, so a merge today does not change recall. Zero merge actions have ever been written anyway.
- Exemplar machinery: bucket cap is wired (flag-gated off); pruneReverted and pruneOlderThan have no callers, and survived is NULL on all 346 rows, so pruneReverted would delete nothing (see #354).
- A re-derivation metric ALREADY EXISTS (`nlm metric re-derivation`, entity-sharing session pairs >7d apart with decision-Jaccard >= 0.5 and no continues/supersedes edge). It is on-demand, sqlite-only, and gates nothing.
- Markers (13,444) already cascade with session deletion; facts already have supersedence + retirement machinery.

## Design principle

Consolidation before deletion, measurement before either. The near-term recall-quality lever is entity hygiene (the candidate swamp pollutes every entity-based surface: recall filters, workstream matching inputs, related-facts, the UI). The near-term safety lever is monitoring plus a re-derivation baseline, so that when compaction IS needed there is data to gate it. Destructive compaction ships last, dormant, and Edward-gated.

## Stage A: instrument (non-destructive, ship first)

1. **Corpus-size monitor.** A 24h daemon job (pattern: the integrity-check timer) computes db bytes, session count, body bytes, entity count + hapax share, facts (active/superseded/retired), markers, exemplars; writes one JSONL line to `~/.nlm/corpus-stats.jsonl` and exposes the latest snapshot + threshold state in `/api/health` detail and `nlm health`. Thresholds env-tunable: `NLM_CORPUS_WARN_BYTES` (default 1GB), `NLM_CORPUS_ALERT_BYTES` (default 2GB). Alerting = health field + stderr log line; no push channel (the work-digest can read the health field later).
2. **Re-derivation baseline.** Schedule the existing metric weekly (same 24h timer, run when 7 days have elapsed since the last entry) appending to `~/.nlm/re-derivation-trend.jsonl` with window=42d. This builds the Stage C gate data starting now. No behavior change.
3. **Exemplar prune wiring.** Wire `pruneReverted` next to the existing bucket-cap call in the scheduler sweep (same `NLM_CODE_EXEMPLARS_ENABLED` gate). `pruneOlderThan` stays uncalled (nothing sets a policy age; YAGNI until the lane is alive, see #354). This satisfies the "wire the existing prune" audit item at its honest current value: near-zero, because the lane is inert.

## Stage B: canonical entity consolidation (the recall-quality lever)

1. **A real merge primitive** (storage level, both backends): `EntityStore.merge(source, target, opts)` rewrites `session_entities.entity_canonical` source->target (dedup-safe on the composite PK), folds `session_count` (recomputed exactly from session_entities, not added, to heal the measured ~886-row count drift), folds first/last seen, writes `entity_variants(variant=source, canonical=target)` (the dead table becomes the alias memory so re-ingest does not resurrect the source), and marks the source row status='retired' (KEEP the row: no hard delete, no cascade surprises, history preserved). Ingest gains a variants lookup so future occurrences of a merged surface form bind to the canonical directly.
2. **Suggestion pass, operator-adjudicated.** `nlm entities dedup` computes candidate pairs lexically: case-fold equality, punctuation/whitespace normalization, singular/plural, and the repo-suffix pattern (x vs x-ts style). Two classes: SAFE (case/punct-fold identical) auto-applied with `--apply` (default dry-run prints the list); everything else printed for per-pair confirmation (`--interactive`) or piped adjudication. No embedding similarity in v1: the workstream matcher falsification showed lexical-adjacent-but-different entities are exactly where embeddings over-merge; start conservative.
3. **Not in scope here:** entity TYPING/promotion (candidate -> project/tool/...) stays with #262/#273; this stage only collapses duplicates. The merge primitive is shared groundwork for both.

## Stage C: body compaction past TTL (destructive, parked)

Shape (for the record; NOT in the build plan until gated): `nlm compact --older-than <days> --dry-run` moves `sessions.body` for old, non-capped, non-superseded sessions into a compressed archive under `~/.nlm/archive/`, leaves label/summary/markers/facts/embeddings untouched, rebuilds the FTS row (keyword recall over archived bodies degrades to label+summary), and get_session reads through to the archive on demand. Supersedence pointers and "show original" are preserved because sessions rows are never deleted.

**Gate to unpark:** (a) >= 4 weeks of re-derivation-trend baseline exists AND is flat, (b) corpus monitor shows warn threshold crossed or projected within 8 weeks, (c) Edward signs off on the TTL and the keyword-recall degradation for archived bodies. All three, not any.

## Open questions for Edward (none block Stage A+B)

1. Stage C TTL default when it unparks: 180d matches the recency half-life; confirm or pick.
2. Whether the corpus monitor's alert should also land in the Telegram digest chat once thresholds trip (needs a push channel the daemon does not have today).
3. Appetite for `--interactive` merge adjudication vs batch review of the non-safe suggestion list.
