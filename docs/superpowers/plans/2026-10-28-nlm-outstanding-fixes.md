# NLM outstanding fixes (T1187: #943, #617, T1182, T1183, T1186, #616, #781)

## Context

After T1177 restored capture throughput, read-only investigations found:
- **Fact supersede regression (live).** With `NLM_PROPERTY_ASSOCIATIONS=1` (set in the live
  `~/.nlm/.env`; `NLM_PROPERTY_INFERENCE=0`), facts whose `property_slug` is NULL are treated
  as "independent" and never supersede prior active facts (`src/core/storage/fact-batch.ts`
  ~:18 and ~:31, `src/core/properties/model.ts` ~:35, feature commit 4689966). The deploy on
  2026-10-28 shipped it: 22 new active conflicts in the first 10 minutes. 78 conflict groups
  (171 facts) exist in total. Details: `/Users/echalupa/.nlm/evaluations/T617/findings.md`.
- **#943 Codex text loss.** `extractTurn` in `src/core/adapters/codex.ts` reads user/assistant
  text only from `event_msg` `user_message`/`agent_message`. Codex CLI ≥0.151 emits
  `event_msg` with `payload.type == "item_completed"` and `item.type` `UserMessage` /
  `AgentMessage` (with `phase`) instead. ~95% of Codex rollouts lose all text; many parse to
  null and (since T1177) get recorded as empty. Details:
  `/Users/echalupa/.nlm/evaluations/T943/findings.md` (repro: `repro.mts` there).
- **#617 integrity.** I7b-1 orphan chunk embeddings are 0 now, but the creation path is
  non-atomic (`sqlite-session-store.ts` insertChunkEmbedding ~604-621 / deleteSessionChunks
  ~582-595; `embed-backfill.ts` ~265-280) and `doctor --fix` has no I7b-1 repair. Chunk-embed
  failures (embedder unreachable) are swallowed per chunk with no retry
  (`sqlite-session-store.ts` ~570, `pg-session-store.ts` ~667). The I5a doctor query isn't
  tenant-scoped and counts event-class predicates.
- Small items: T1182 (scan-once `statSource` calls `adapter.stat` unguarded — a busy DB aborts
  that adapter's tick), T1183 (drift alert check writes alert-state.json on its own timer,
  clobbering the embedder/ingest-lag streaks), T1186 (Settings → Classifier "Switch model"
  preselects Ollama while the active provider is openai; model list "fetch failed"), #616
  (retire `qwen3.5:4b`: `RECALL_GATE_MODEL`, `USEFULNESS_MODEL` hardcode it), #781 (`npm run
  build` rewrites four tracked bundles: regenerate and commit).

## Global Constraints

- Repo `nlm-memory`; gate `npm run typecheck && npm test`; `npm run build:ui` when UI changes.
- SQLite and Postgres paths both get every storage fix.
- YAGNI, no dead code, no compat shims, tests assert behavior.
- No change touches the live DB or `~/.nlm` from tests or scripts; one-shot repair commands
  are code shipped in the repo, run by the controller after deploy with a backup first.
- Repairs must be reversible or preceded by a `.backup`; never blanket-collapse parallel
  predicates (`description`, `decided-on`).

## Task 1: Fact supersede regression + I5a check

1. In fact-batch, a NULL-`property_slug` fact is "independent" (does not supersede) only when
   its source is `operator`; every other NULL-slug fact supersedes like before the
   associations feature. Facts with a slug keep the current per-property behavior. Read
   `src/core/properties/model.ts` and the 4689966 commit to keep the feature's intent.
2. I5a doctor check: group by `tenant_id` too and exclude event-class predicates (find the
   existing predicate classification; don't invent one).
3. Tests: with associations on, a NULL-slug non-operator fact supersedes the prior active
   fact with the same subject+predicate; an operator NULL-slug fact does not; slugged facts
   unchanged; I5a ignores cross-tenant and event-class pairs.
4. Repair command `nlm doctor --fix` gains an I5a repair limited to groups created by the
   regression: same tenant, same subject+predicate, NULL slug, non-operator, not a parallel
   predicate — supersede older by newest (set `superseded_by`; re-queue the fact embedding
   the way supersession normally does). Print what it changed. Dry-run is the default
   output of `nlm doctor`; `--fix` applies.

## Task 2: Codex `item_completed` capture + re-ingest

1. `extractTurn`: add the `item_completed` branch — `UserMessage` → user turn (join
   `content[].text`), `AgentMessage` → assistant turn keeping the existing rule that skips
   non-`final_answer` phases. Keep the 0.148 branches. Do not use `response_item.message` as
   the source (it includes the synthetic AGENTS.md preamble).
2. Fixture `tests/fixtures/codex/item_completed_session.jsonl` (trimmed, anonymized, built
   from the shape in the findings), tests in `tests/unit/core/adapters/codex.test.ts`: turn
   counts by role, phase filtering, mixed old/new shapes.
3. One-shot re-ingest: a CLI subcommand (e.g. `nlm reingest --adapter codex`) that re-parses
   every source of the given adapter from disk and re-ingests sessions whose parsed body
   changed (including sources recorded as empty), reusing the `reclassify-oversized` loop
   with a different selector — not a second ingest path. It respects the classifier tuning
   and must be resumable (idempotent re-run skips sources already re-ingested at the current
   size). `--dry-run` reports counts.

## Task 3: Chunk-embed atomicity, I7b-1 repair, failed-chunk retry

1. Wrap insertChunkEmbedding's vec insert + map insert, deleteSessionChunks' pair, and the
   embed-backfill pair in a transaction (sqlite) / the pg equivalents.
2. `doctor --fix` repairs I7b-1 (delete orphan vec rows without a map row).
3. Persist chunk-embed failures (session id + chunk index) and retry them on a sweep, the way
   `fact_embed_pending` + fact-embed-sweep work for facts; reuse that machinery's shape.
   Migration next numbers after 047 / pg 043.
4. Tests for each.

## Task 4: Small fixes batch

1. T1182: in scan-once (sqlite + pg) catch `adapter.stat` errors per source: skip that source
   this tick, log once per tick, continue the scan.
2. T1183: run the drift check in the same sequential alert timer as the embedder and
   ingest-lag checks (`src/cli/nlm.ts`), each failure isolated; delete its own timer.
3. T1186: Settings → Classifier "Switch model" preselects the active provider (match by
   kind, including `openai`) and lists its models; when the provider registry has no row for
   the active provider, show the active provider read-only instead of preselecting another.
4. #616: remove `qwen3.5:4b` from `RECALL_GATE_MODEL` / `USEFULNESS_MODEL` and the Ollama
   gate path — repoint to the classifier lane (`litellm-classifier` via the configured
   classifier client) or delete the path if the gate is off and unused; then grep for any
   remaining `qwen3.5` reference and resolve each.
5. #781: run `npm run build` and commit the regenerated tracked bundles.
6. Tests for 1-4; `npm run build:ui` for 3.

## Verification (controller, after landing)

Deploy as a new `versions/` entry with a DB backup; restart; run `nlm doctor` (dry run) then
`--fix`; run `nlm reingest --adapter codex --dry-run` then for real; confirm Codex sessions
gain user/assistant turns, I5a conflicts drop, no new conflicts appear over the next hour,
ingest health stays green.
