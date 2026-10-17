# Task 6 — literal source integrity implementation report

Status: implemented, committed, focused validation green; independent parent review pending. The proposed 50% CPU reduction does **not** pass for the actual all-legacy sample. It passes for the separately identified counterfactual newly written/versioned population only. No deployment, installed-daemon mutation, corpus backfill, automatic fact retirement or heldout evaluation was performed.

## Revisions and scope

- Assigned code baseline: `6ae95c7627add7b26ef23d1348c3045274572d1d`.
- Parent-owned status/spec documentation subsequently committed: `9a4164a` and `ce5e363`. Preserved without editing those files.
- Implementation/tests/docs commit: `ce784f996ad47fedafc57114e15512c2686fa213` (`Work-Id: T806`).
- Branch/worktree: `feat/T806-memory-retrieval`, `/Users/echalupa/.nxtos/worktrees/nlm-memory-T806`.
- This report is a subsequent documentation-only commit; its SHA is returned to the parent.

The parent approved the necessary SQLite FTS trigger correction after the old-writer regression reproduced corruption. The parent also clarified that legacy `quoteVerified` must preserve bounded read-only unique-literal verification, and approved optional observed `bodyVersion` on invalid/ambiguous assessments, without offsets, using the already planned column. Those rulings are reflected in the parent's binding spec commit.

## Behavior

`bodyVersion` implements the existing 16-hex SHA-256 transcript contract. `persistedText` makes the drivers' UTF-8 replacement of unpaired surrogates explicit before locating quotes. Extraction receives the capped persisted-body representation, normalizes both body and quote, finds one literal occurrence with UTF-16 offsets, and hashes the source at most once per extraction batch. Repeated and overlapping occurrences are ambiguous; an absent quote is invalid; an empty/missing quote is missing. No classifier call was added.

Verified anchors retain `{status,start,end,bodyVersion}`. Invalid/ambiguous assessments can retain their observed body version but never offsets. Missing/stale results contain only status. Stored assessments compare against the current tenant-owned source version on every fact projection. Changed, missing or foreign source versions cannot supply trusted offsets. Confidence has no role in verification.

Matching positive and negative assessments use metadata only in compact context. Legacy/stale/unversioned assessments fetch only the selected source bodies under the existing shared request budget, deduplicated by source ID. A fresh literal search supplies only the ephemeral `quoteVerified` boolean; it never persists or upgrades a durable anchor. The boolean-only fallback does not need SHA materialization. An old durable anchor can remain stale while a newly fetched body proves the quote at a different location. Overlapping repetitions remain unverified. Complete evidence packing, selectors, exact-value probes, semantic worker lifecycle, cancellation and limits retain their existing implementations.

Expansion still fetches full bodies and slices in JavaScript, preserving UTF-16 semantics. It rechecks tenant/workstream eligibility, validates emitted fact anchors against the fetched session version, and uses the shared version helper for existing transcript pagination checks. There is no SQL `substr` range-read optimization or claim that expansion avoids body I/O.

## Write-path coverage

| Entry point | Implementation / validation |
| --- | --- |
| Scheduler classification | Passes `record.body` to existing extraction; existing scheduler and PG scheduler integration tests pass. Source/cap wiring inspected. |
| Webhook `ingestSession` | Passes capped `record.body`; dedicated shared adapter test proves a quote beyond 200,000 characters is invalid and classifier called once. |
| Oversized reclassification | Passes capped `record.body`; compiled and source-call-site audit performed. No new standalone oversized anchor integration test was added. |
| Explicit reprocess | Passes the exact record body; existing reprocess suite passes. |
| Explicit fact backfill | Passes the stored row body; uses the bounded `insertFactsForSession` path. No backfill was executed. |
| SQLite/PG `insertSession` | Normalizes body and atomically writes body/version plus session facts inside existing transaction. Both adapters test positive/negative source changes, unchanged reingest and fact-insert rollback. |
| SQLite/PG seed helpers | Normalize/version source bodies; MCP fixtures exercise these, including fact-only version metadata reads. |
| SQLite fact insert/insertMany/internal ingest | Persist normalized quote and anchor columns through canonical row conversion. Shared adapter tests cover single/bulk insert and ingest. |
| PG fact insert/insertMany/ingest-on-client | Persist explicit anchor values in SQL parameter order. Same shared adapter tests execute on real PG. |
| Explicit `insertFactsForSession` maintenance | Reads tenant-owned current body and stamps its version inside the fact transaction. PG locks that source row. Both adapters test successful nullable-source version establishment and rollback of version+facts on a duplicate-fact failure. |
| Compatible old UPDATE/UPSERT | Database guard nulls the version when body changes without version change. Both adapters test old-style UPDATE and UPSERT, unchanged-body controls and stale-anchor reads. |

All `extractFacts` production call sites and session-body SQL writes were enumerated. Other session writes change status/bindings/metadata, not the body. Direct fact insert APIs persist supplied extraction assessments; they do not invent anchors or silently scan/update sources.

## Read projections and integrity

Both adapters include all anchor columns and a current source-version join in `getById`, `getByIds`, `findCurrent`, `list`, `listBySession`, `listBySessions`, `listForRecall`, and both `getHistory` branches. SQLite `listBySubjects` is covered too. PG `listBySubjects` remains explicitly unsupported as before. The joined source aliases expose only version/identity/tenant metadata and match the fact's tenant; there are no hidden row-by-row adapter reads or writes. Existing SQL tenant-guard and table-census tests pass without allowlist changes.

Session `getByIds` carries the body version without the body. Full `getById` additionally carries the current workstream for expansion fencing. Tests exercise every supported fact projection, both current-source tenant matching and a deliberately mismatched source tenant, including negative assessments. Compact-context tests prove:

- Unique null-version legacy quotes still yield fresh literal proof.
- `total_changes()` is unchanged by legacy recall and stored source version/anchor remain null/missing.
- Matching positive and negative assessments avoid fact-only `getById` calls.
- Old-writer body changes force fresh hydration; absent/repeated assessments can become uniquely valid without rewriting the stored assessment.
- Stale offsets are never trusted; `aaaa`/`aa` remains ambiguous.
- Existing workstream, foreign/unknown scope, pagination/version and whole-record packing tests remain green.

## Migrations, rollback and Unicode

The next unused versions were SQLite **043** and PG **039**. Existing 042/PG038 files were not edited. Only five nullable columns were added; no new tables or startup-wide hash/backfill exists. Upgrade tests actually build pre-anchor schemas, insert historical sessions/facts, apply just the next migration, verify unchanged source/quote and all new fields null, and rerun migrations as a no-op. The existing tenant table census remains unchanged and passes.

SQLite uses a narrow AFTER UPDATE OF body guard; PG uses BEFORE UPDATE OF body. SQLite's metadata-only inner UPDATE initially caused the old unqualified FTS UPDATE trigger to delete text that was not yet indexed: old-style UPDATE/UPSERT tests raised `database disk image is malformed`. Migration 043 recreates `sessions_au` with the identical delete/insert body and `AFTER UPDATE OF label, summary, body`, preventing version-only recursion. Tests verify old term gone/new term present, label and summary updates, metadata-only writes, and FTS5 external-content integrity checks. Current session write paths do not mutate rowid. The schema additions remain compatible with older writers; rollback does not auto-retire facts.

Unicode tests run against both databases and assert exact stored quote equality, slice boundaries and version. Cases include emoji/non-BMP before a quote, a combining mark, overlapping matches, and a 200,000-code-unit cap ending on an unpaired high surrogate. Both body and quote roundtrip to U+FFFD before offsets are persisted. SQL code-point offsets are never substituted for JS offsets.

## TDD and validation record

Initial RED command:

```sh
NLM_PG_TEST_URL=postgresql://nlm_test:nlm_test@127.0.0.1:54329/nlm_test npx vitest run tests/unit/core/facts/source-anchor.test.ts tests/integration/fact-source-anchor.test.ts tests/integration/fact-source-anchor.pg.test.ts --reporter=dot
```

Result: 3 failing suites because the required source-version/source-anchor helpers did not exist. After initial implementation, the same tests exposed the SQLite FTS recursion defect above. Test fixture corrections were also needed: this store resolves `:memory:` as a file path (replaced with isolated temporary databases; the owned accidental file was removed), PG's intentionally unsupported wiki projection was removed from PG expectations, and the upgrade fixture enabled WAL before running migration 000. These fixture failures are not counted as product defects. The initial 24 source tests then passed, and coverage was expanded.

Final checks:

```sh
npm run typecheck
npm run build:server
NLM_PG_TEST_URL=postgresql://nlm_test:nlm_test@127.0.0.1:54329/nlm_test npx vitest run tests/unit/core/facts/source-anchor.test.ts tests/unit/core/facts/extract-facts.test.ts tests/unit/tenant-census.test.ts tests/integration/tenant-guard.test.ts tests/integration/fact-source-anchor.test.ts tests/integration/fact-source-anchor.pg.test.ts tests/integration/source-anchor-upgrade.test.ts tests/integration/source-anchor-upgrade.pg.test.ts tests/integration/sqlite-fact-store.test.ts tests/integration/fact-store.pg.test.ts tests/integration/fts-index.test.ts tests/integration/keyword-search-fts.test.ts tests/integration/mcp-context.test.ts tests/integration/pg-ingest.pg.test.ts tests/integration/pg-fact-ingest.pg.test.ts tests/integration/reprocess.test.ts tests/integration/scheduler.test.ts tests/integration/context-deadline.test.ts tests/unit/core/context/recall-context.test.ts tests/unit/core/context/coverage-packing.test.ts --reporter=dot
```

Results: typecheck PASS; server build PASS; **20 files / 267 tests PASS**, with real PG enabled. After adding explicit stored-negative-null-offset and foreign-negative assertions, typecheck and the two adapter anchor suites were rerun: **26 tests PASS**. `git diff --check` and staged diff checks passed. This repository has no `.agent-quality.yml`; the full unrelated suite remains the parent's Task 10 gate, not a claimed result here.

## CPU diagnostic

Command:

```sh
npx tsx scripts/eval/source-anchor-cpu.ts /Users/echalupa/.nlm/eval/snapshots/2026-10-15/canonical.sqlite /Users/echalupa/.nlm/eval/memory-context/2026-10-16-T806/task6-anchors
```

Private files: `source-clone.sqlite`, `cpu-results.json`, `cpu-results-before-negative-cache.json` under that output directory. No original snapshot writes or migrations occurred. Original SHA-256 before/after and clone SHA all equal `08a6b4f2493ca4128b3c7ae0dac590c4d1ed1b7ba2bd0be9044859be4fbb05c7`.

Sampling was fixed at 256 of 9,977 nonempty quoted facts, ordered by SHA-256 of a fixed prefix plus fact ID. Only source/fact development data was read; no heldout queries/outcomes/questions, ranker labels or classifier calls. All 256 sampled sources lack persisted versions. Offline literal checks find 95 unique, 142 absent and 19 ambiguous quotes. No sample facts are excluded from the all-quoted denominator. Counterfactual anchors are constructed only in RAM and never written into the clone or original.

CPU measurement excludes DB I/O, clone/hash checks, source loading and anchor preparation. Seven alternating paired rounds follow warmup; each round repeats 200 times. Source preload plus offline preparation was 104.89 ms, reported separately. Medians:

| Population | Operations/round | Old includes CPU | New verification CPU | Reduction |
| --- | ---: | ---: | ---: | ---: |
| Actual legacy sample, fresh unique-literal fallback | 51,200 | 515.492 ms | 608.684 ms | **−18.08%** |
| Counterfactual current new-write assessments, all 256 quotes | 51,200 | 504.857 ms | 4.635 ms | **99.08%** |
| Counterfactual current unique positive subset, 95 quotes | 19,000 | 61.881 ms | 1.602 ms | **97.41%** |

The earlier retained diagnostic used unnecessary SHA materialization in boolean legacy verification and lacked reusable versioned negatives: actual legacy cost was +197.75%, counterfactual mixed reduction 9.85%, unique positive reduction 97.18%. Removing unneeded hashes and reusing explicitly approved current negative assessments improved those results without dropping legacy proof or accepting repeated quotes.

The actual sampled corpus therefore **fails** the proposed >=50% CPU reduction gate. New-write populations meet it in this isolated diagnostic, but that is conditional on versioned ingestion/explicit maintenance and cannot be promoted as a historical corpus-wide result. Baseline `includes` accepts repetitions, while the new proof requires uniqueness; only the unique positive subset has identical positive semantics. These numbers do not establish whole-request latency, database join costs, or I/O savings for legacy sources. Newly versioned positive/negative fact-only sources avoid full-body hydration, proven separately by transport spies. Legacy fallback and transcript expansion still read full bodies.

## Files, self-review and remaining concerns

The implementation commit changes 34 explicit files. Core groups are the new source version/literal/storage conversion helpers; shared types/ports; five extraction call sites; both session/fact adapters and PG fact ingest; context hydration/packing and session expansion; two nullable migrations; the CPU diagnostic and source-anchor documentation; and shared unit/adapter/migration/transport/FTS tests. Exact file census is `git show --stat ce784f996ad47fedafc57114e15512c2686fa213`.

Self-review checked every fact projection for required columns, normalization before offsets, atomic source-version writes, stale/foreign fail-closed behavior, no trusted negative offsets, old writer guard behavior, no query-time persistence, and no added model calls. Existing exact-value SQL probes, semantic readers/worker pool and cancellation logic were not edited. The only hydration change is bounded source selection for fresh quote proof and preserving a previously loaded body when its source version still matches.

Remaining limitations: actual legacy CPU does not meet the proposed gate; source expansion remains full-body; no deployed-data migration/backfill or full-suite claim; old columns remain nullable; PG wiki subject reads remain unsupported as before; oversized/reprocess/backfill source-body plumbing was code-audited and covered by compilation/existing suites rather than separate new anchor-specific end-to-end cases for every CLI. Independent parent review is required before treating this task as reviewed. All owned test/benchmark processes exited, temporary fixtures and PG test schemas were removed by their lifecycles, the pre-existing PG container was left running, and private diagnostic artifacts were retained outside git. No subagents or external review launchers were used.
