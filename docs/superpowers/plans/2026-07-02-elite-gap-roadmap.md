# NLM Elite-Gap Roadmap

Strategic plan addressing the four gaps from the 2026-07-01 senior review that separate NLM from an elite agentic memory layer. Each phase becomes its own SDD implementation plan when picked up; this document locks scope, ordering, and gates.

## Guiding principle: tier-adaptive, local floor

NLM ships against arbitrary user systems. The floor configuration (small local model via Ollama, local embedder, SQLite) must work everywhere with zero cloud dependency. Users who configure a stronger endpoint (any OpenAI-compatible URL, local or API) get better results from the same code paths. Therefore:

- No feature may require a specific model, host, or vendor.
- Every LLM-lane improvement is expressed as: same prompt contract, measured per tier, with published expectations.
- Quality upgrades must be retroactive: when a user upgrades their model lane, existing corpus data can be reprocessed, not just future sessions.

## Phase 1: Embedding interop and parity hardening (REVISED 2026-07-02)

Correction: the originally scoped work (chunked embeddings, #174/#175) shipped 2026-05-25 via migration 009. Both backends chunk session bodies (5500 chars, 500 overlap), store per-chunk vectors, and max-pool at query time. Measured post-ship: hybrid R@5 97.2 on LongMemEval-S, hybrid beating keyword on aggregate for the first time. Retrieval mechanics are not the gap.

The real Phase 1 gap is shipping the embedding lane against arbitrary user systems. Today nothing records which embedding model produced the stored vectors, dimensions are structurally fixed at 768 in the DDL, a model or dim swap silently poisons recall with no detection, and the reembed harness is SQLite-only.

**Scope:**
1. Embedding lane metadata (`embedding_config` table, both backends): provider, model, dim per lane (prose, code), reconciled against the running embedder at daemon startup.
2. Stale-lane detection: on mismatch, semantic recall degrades to keyword (never garbage), health reports the stale lane, and the operator is told to reembed.
3. Dimension-flexible reembed: `embed-backfill` rebuilds vector tables at the configured dimension when it changes, then re-embeds sessions and facts. Unlocks non-768 API embedders.
4. Postgres reembed harness (parity with the SQLite one) plus chunk-level ghost invariant (I7b) in check-invariants.
5. Legacy cleanup: drop the pre-chunking `session_embeddings` table and its one-shot normalize tool; fix stale comments that still describe chunking as unbuilt.

**Gate:** full suite + pg pass green; a simulated model swap on a test corpus is detected, degrades cleanly, and recovers via reembed; no behavior change for a matched-config install.

## Phase 2: Extraction quality (capability tiers, retroactive upgrades)

Extraction is bounded by the configured model, not the architecture. Make the tier explicit, measured, and upgradeable after the fact.

**Scope:**
1. Extraction provenance: store model tag and confidence on classification outputs (sessions and facts). Cheap columns, enables everything below.
2. Tier benchmark harness: run the locked gold sets (naming, classification) against the configured lane and report scores. Productize as `nlm eval`, so any user can measure what their configured model actually delivers on THEIR hardware. This converts our internal eval discipline into a shipped feature and sets honest expectations per tier.
3. `nlm reprocess`: re-run extraction over low-confidence or floor-tier-extracted sessions when a stronger lane is configured. Provenance decides eligibility; supersedence handles fact replacement (the #351-class machinery already guarantees correctness here). This is the retroactive upgrade path: flip to a better model, corpus quality improves, not just new sessions.
4. Published tier expectations in docs: floor (4B-class local), mid (20-30B-class via any OpenAI-compatible endpoint), cloud API. One prompt contract, three measured operating points.

**Gate:** `nlm eval` runs green against all three lane types; `nlm reprocess --dry-run` correctly selects candidates by provenance; a sample reprocess on gold sessions shows strictly-better or equal labels.

## Phase 3: Consumer-side precision loop

Memory quality is bottlenecked by whether the consuming agent actually uses recall well. Close the loop and ship the consumer contract.

**Scope:**
1. `nlm init --agent <claude-code|generic>` emits the recall-behavior snippet (when to recall, when to cite, when not to) for the user's agent instruction file. Today this contract is hand-rolled in the operator's workspace; shipped users get nothing. This is the single biggest interop gap on the consumer side.
2. Citation-frequency reranker maturation: it is seeded; let it accumulate, then measure reranked vs unranked precision on the citation log. Promote or remove based on data (no zombie half-features).
3. Precision telemetry surfaced: `nlm precision` trend included in work-digest and /api/health detail, so degradation is visible to the human without asking.

**Gate:** fresh-install simulation produces a working agent contract file; precision metric visibly moves or the reranker is cut.

## Phase 4: Relational recall (instrument first, build only if data demands)

Flat subject-predicate facts cannot answer traversal questions ("what depends on X"). But a temporal knowledge graph is a large investment and the honest answer is we do not yet know how often relational questions occur.

**Scope:**
1. Instrument: classify recall queries by intent (lookup vs relational) in the citation log. Zero product change, two weeks of data.
2. Cheap 80%: join-based related-facts expansion in recall_facts (shared subject, shared session provenance) using existing tables. No new storage, no graph engine.
3. Full temporal KG: explicitly deferred until instrumentation shows relational intent above a meaningful share of recall traffic. Do not build speculatively.

**Gate:** intent distribution report; join-based expansion shipped only if relational share is non-trivial; KG decision made on numbers.

## Ordering rationale

Phase 1 first: it is the interop prerequisite for everything model-related, is fully fenced and test-gated, and prevents the worst shipped failure mode (silent recall poisoning on a model swap). Phase 2 second and now the largest quality lever: the published 97.2 R@5 baseline was produced with frontier-tier classifier labels, and the end-to-end delta for the local floor is unpublished; `nlm eval` makes that honest per install. Phase 3 third: needs corpus and citation volume. Phase 4 last and gated: the only phase where the right move might be "don't".

## Out of scope

- Multi-user or hosted deployment (single-user local-first is the product).
- Vendor-specific integrations beyond the OpenAI-compatible contract.
- Replacing the storage engines (SQLite floor + Postgres option is settled).
