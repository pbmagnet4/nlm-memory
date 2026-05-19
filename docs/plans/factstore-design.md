# FactStore Design Plan (nle-memory-ts)

**Deliverable target:** `~/projects/nle-memory-ts/docs/plans/factstore-design.md`
**Status:** Design only. No code in this pass.
**Author context:** Edward Chalupa, May 2026. Phase F shipped; SqliteSessionStore is live (not pending — prompt was stale on that point).

## Context

nle-memory today treats the **session** as the unit of memory. Sessions work for *operator recall* ("what did we decide about pgvector"): a digest with label, summary, decisions[], open[], entities[] is the right grain when the consumer is a human paging through their own history.

Sessions are the **wrong** unit for *agent-in-loop recall*. When Claude Code mid-task needs to know "what model alias does the Mac Pro endpoint expose" or "did Edward pick Hono or Fastify," the answer is a single sentence. Returning a 6KB session digest forces the agent to re-extract the fact from prose — burning tokens and trusting an LLM read-through to find what was already extracted at ingest time.

The raw signal is already captured. `src/core/classifier/prompt.ts` extracts `decisions[]`, `open[]`, `entities[]` from every transcript. Those live as denormalized arrays on the Session row. The work is **promotion**: turn those strings into first-class queryable records with their own port, store, recall path, and MCP surface — without breaking hexagonal discipline and without diluting the session-as-primary-unit differentiator (vs. Mem0's fact-soup and Graphiti's graph edges).

This plan covers the seven design decisions needed to ship a FactStore alongside SessionStore. Phased rollout at the end; no Phase A.2 work is gated by this plan because SqliteSessionStore is already shipped.

---

## 1. Fact Model

Minimum schema for a `Fact` record:

```ts
interface Fact {
  id: string;                          // ULID
  kind: "decision" | "open" | "attribute";
  subject: string;                     // normalized entity or topic, lowercased
  predicate: string;                   // short verb-phrase, lowercased ("framework", "endpoint", "decided-on")
  value: string;                       // the answer, free text, sentence-ish
  sourceSessionId: string;             // FK → sessions.id
  sourceQuote: string | null;          // verbatim slice from session.body (provenance)
  createdAt: string;                   // ISO 8601, copied from session.endedAt
  supersededBy: string | null;         // FK → facts.id (null = current)
  confidence: number;                  // 0..1, inherited from classifier confidence
}
```

**Decision:** Ship with exactly these fields. No `scope`, no `expiry`.
**Why:** `scope` is implicit in `subject` (subject="mac-pro-llm-host" is its own scope). `expiry` is what `supersededBy` is for — facts don't time out, they get replaced. `confidence` earns its row because the classifier already returns it; dropping it forfeits a free signal for ranking and conflict resolution. `sourceQuote` is the cheap insurance against hallucinated extraction — when a fact looks wrong, the operator wants to see the exact line from the transcript without re-reading the whole session.

Indexed on `(subject, predicate)` and `subject` alone. No `kind` index — `attribute` will dominate volume and selectivity comes from `subject`.

---

## 2. Supersedence Semantics

**Decision:** Deterministic-first hybrid. On ingest, exact `(subject, predicate)` collision against an existing non-superseded fact sets the old fact's `supersededBy = new.id`. No LLM in the hot path. A separate `consolidate_facts` operator-triggered MCP tool runs LLM-driven semantic dedup over candidate clusters (same subject, no exact predicate match) when Edward explicitly asks.

**Why:** Pure LLM-driven supersedence at every ingest doubles classifier cost and introduces non-determinism — bad for a local-first daemon that runs unattended on a laptop. Pure rule-driven misses "use Hono"/"chose Hono as the framework" because predicates won't match. Manual-only forfeits the obvious wins. The hybrid keeps ingest cheap and deterministic, accepts some duplicate-fact accumulation as the cost of that determinism, and gives Edward an explicit tool to clean up when he notices clusters. Supersedence is also reversible (set `supersededBy` back to null) because we keep the old row — facts are append-only with a tombstone pointer, never deleted.

Predicate normalization matters here: the classifier prompt extension (Section 3) must map synonymous phrasings to a canonical predicate during extraction, or the deterministic path catches nothing. We give the LLM a closed list of ~20 common predicates ("framework", "endpoint", "model", "decided-on", "pricing", "deadline", "owner") and an "other" escape hatch. This is the same trick `entities[]` uses today — controlled vocabulary at extraction time, not at query time.

---

## 3. Ingest Path

**Decision:** Extend the existing classifier prompt to return structured facts alongside the existing six fields. No new `core/fact-extractor` module, no post-ingest pass. The classifier port (`LLMClient.classify`) already runs once per session; piggyback on that call. A new pure function in `src/core/facts/extract-facts.ts` converts `ClassifyResult.facts[]` into `Fact[]` for the store.

**Why:** A separate post-ingest pass means a second LLM call per session — doubles classifier cost for a marginal architectural cleanliness win. A new core module without a port means the classifier still does the work but pretends it doesn't, which is worse. The classifier prompt is already the chokepoint where "raw transcript → structured signal" happens; facts are just more structured signal. The pure-function transform stays in core, keeps the no-framework-imports rule, and is unit-testable against fake `ClassifyResult` fixtures.

Classifier prompt addition (rough shape):

```
"facts": [
  {"kind": "decision", "subject": "nle-memory-ts", "predicate": "framework", "value": "Hono"},
  {"kind": "attribute", "subject": "mac-pro-llm-host", "predicate": "endpoint", "value": "http://macpro:8080/v1"}
]
```

The existing `decisions[]` / `open[]` / `entities[]` fields on Session stay. They are the operator-facing prose digest. Facts are the agent-facing normalized projection. Both come from the same LLM call. Duplication is intentional — sessions and facts answer different questions.

Confidence cap: facts with classifier-reported confidence below 0.6 are extracted but flagged `confidence < 0.6` in queries by default (filterable). Below 0.4, dropped entirely.

---

## 4. Recall Blending

**Decision:** Separate `FactRecallService.search()` and a separate MCP tool `recall_facts`. Session recall and fact recall do not blend in a unified result type. The UI (Edward browsing) gets a small enrichment — when a session result has facts attributable to it, the digest shows a fact count and a "view facts" affordance, but the primary list stays session-keyed.

**Why:** The two consumers want incompatibly-shaped results. An agent calling `recall_facts(subject="mac-pro-llm-host", predicate="endpoint")` wants `[{value: "http://macpro:8080/v1", confidence: 0.9, sourceSessionId: "..."}]` — a JSON array of 1-3 items at most, no prose. Edward calling `recall_sessions("pgvector decision")` wants a ranked list of session digests with summaries. A unified `kind: session | fact` result type forces both consumers to handle a polymorphic shape, hurts both, and obscures the conceptual primacy of sessions. The "facts only surface as enrichment" option fails the agent use case — the agent shouldn't have to fetch a session to read a fact.

`FactRecallService.search()` signature:

```ts
interface FactQuery {
  subject?: string;        // exact match, normalized
  predicate?: string;      // exact match, normalized
  query?: string;          // free-text against value, keyword + optional semantic
  kind?: Fact["kind"];
  includeSuperseded?: boolean;  // default false
  minConfidence?: number;       // default 0.6
  limit?: number;               // default 10
}
```

Semantic search over `value` reuses the existing nomic-embed-text + sqlite-vec stack. Subject/predicate exact match runs first as a cheap filter; query-text scoring runs over the filtered set.

---

## 5. Storage

**Decision:** Same SQLite file. New tables `facts` and `fact_embeddings (vec0)`. FactStore is a separate port (`src/ports/fact-store.ts`) with a separate adapter (`src/core/storage/sqlite-fact-store.ts`).

**Why:** Two SQLite files would mean either (a) two database connections in the composition root with no cross-store transaction, or (b) attaching one to the other at runtime with all the locking surprises that brings. Atomic session-plus-facts ingest is the common case — when a transcript classifies into one session row + 4 fact rows, those should commit together or roll back together. One file, one connection, one transaction. sqlite-vec is already loaded for `session_embeddings`; reusing it for `fact_embeddings` is free.

Separate port is non-negotiable for the hexagonal discipline. A future Postgres adapter implements both `SessionStore` and `FactStore` against the same connection pool; an in-memory test adapter implements only what the test needs. The port boundary is what makes core testable without a real DB.

Schema sketch (illustrative — not final DDL):

```sql
CREATE TABLE facts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('decision', 'open', 'attribute')),
  subject TEXT NOT NULL,
  predicate TEXT NOT NULL,
  value TEXT NOT NULL,
  source_session_id TEXT NOT NULL REFERENCES sessions(id),
  source_quote TEXT,
  created_at TEXT NOT NULL,
  superseded_by TEXT REFERENCES facts(id),
  confidence REAL NOT NULL
);
CREATE INDEX idx_facts_subject_predicate ON facts(subject, predicate) WHERE superseded_by IS NULL;
CREATE INDEX idx_facts_subject ON facts(subject) WHERE superseded_by IS NULL;
CREATE INDEX idx_facts_session ON facts(source_session_id);

CREATE VIRTUAL TABLE fact_embeddings USING vec0(
  fact_id TEXT PRIMARY KEY,
  embedding FLOAT[768]
);
```

Partial indexes on `superseded_by IS NULL` keep the common-case query (current facts only) on the small index.

---

## 6. MCP Surface

**Decision:** Two new tools.

**`recall_facts`** — primary agent surface.

```
inputs:
  subject?: string
  predicate?: string
  query?: string
  kind?: "decision" | "open" | "attribute"
  includeSuperseded?: boolean (default false)
  minConfidence?: number (default 0.6)
  limit?: number (default 10)
output:
  { facts: Fact[], total: number }
```

**`get_fact_history`** — supersedence chain inspection.

```
inputs:
  subject: string
  predicate?: string
output:
  { chains: Array<{ subject, predicate, history: Fact[] }> }  // newest → oldest
```

**Why these two and not more:** `recall_facts` covers both the agent's "tell me the current value" case (subject+predicate exact) and the agent's "what do we know about X" case (subject only, or free query). `get_fact_history` covers the meta-case — "wait, was this changed recently?" — which is uncommon enough to deserve its own tool rather than a flag on the primary one. Skipping a `write_fact` MCP tool: facts are derived from sessions, not user-asserted. Manual fact insertion punctures the "sessions are primary, facts are derived" invariant and turns nle-memory into Mem0.

A future `consolidate_facts(subject)` tool implements the LLM-driven semantic dedup from Section 2. Not in initial ship.

---

## 7. Migration Path

**Decision:** One-shot backfill script invoked by operator. No lazy-on-read, no never. The script re-runs classifier extraction over every existing session body and writes facts. Existing `decisions[]` / `open[]` string arrays on the Session row are **not** parsed into facts directly — they go back through the classifier with the fact-extraction prompt extension, because the existing strings lack subject/predicate structure and reparsing them with regex would produce worse data than just paying the LLM cost once.

**Why:** Lazy-on-read needs a "have I backfilled this session yet" flag on the session row and a write path in the read path — bad shape, hurts read latency, and the backfill never actually completes for cold sessions. Never-backfill means the FactStore is empty on day one and stays useless until enough new sessions accumulate, which for low-volume runtimes (pi, Codex) could be weeks. One-shot is honest: one LLM-cost spike, one clear before/after, one resumable script with a `last_processed_id` checkpoint. On the Mac Pro local llama-server endpoint at ~22 tok/s, backfilling Edward's session corpus (call it 2000 sessions averaging 8KB body) costs roughly 4-6 hours of wall time on idle iron. Acceptable.

The script lives at `scripts/backfill-facts.ts`, takes `--from <session-id>` and `--limit N` for resumability, logs to `logs/CHANGELOG/CHANGELOG.md` on completion. It re-uses the same `LLMClient` adapter the daemon uses, so no separate inference path to maintain.

Sessions ingested *during* backfill go through the normal path and write facts inline — no race because the backfill script only touches sessions older than its start timestamp.

---

## Phased Rollout

**Phase B.1 — FactStore port + adapter (no extraction yet).**
Ship `src/ports/fact-store.ts`, `src/core/storage/sqlite-fact-store.ts`, schema migration, unit tests with fake adapter. Composition root wires it but nothing writes to it yet. Gates nothing downstream; can ship behind any session work.

**Phase B.2 — Classifier prompt extension + ingest write path.**
Extend `src/core/classifier/prompt.ts` to return `facts[]`. Pure function `src/core/facts/extract-facts.ts` converts to `Fact[]`. Ingest pipeline writes facts atomically with session row. Gated on B.1. New sessions get facts; old sessions stay session-only.

**Phase B.3 — FactRecallService + MCP `recall_facts` + `get_fact_history`.**
Read path goes live. Agents can query. Gated on B.2 (no point shipping read if write is broken).

**Phase B.4 — Supersedence-on-collision logic in ingest.**
Deterministic supersedence path. Gated on B.2 (need writes happening) and a week or two of B.3 data to validate predicate normalization isn't too lossy. If predicates fragment badly, iterate the closed vocabulary before shipping supersedence — otherwise we cement bad equivalence classes.

**Phase B.5 — Backfill script.**
`scripts/backfill-facts.ts`. Run once. Gated on B.2 + B.4 stable (don't backfill before supersedence works or you're re-running it after).

**Phase B.6 — UI surfacing (fact count on session digest).**
React SPA addition. Gated on B.3. Lowest priority — agents are the primary consumer, Edward's session-browsing flow works without it.

**Phase C (deferred) — `consolidate_facts` MCP tool.**
LLM-driven semantic dedup, operator-triggered. Ships only after Edward reports actual duplicate clusters in production. May never ship if predicate normalization holds up.

---

## Critical Files (for the implementer in Phase B)

- `src/ports/session-store.ts` — model the new `FactStore` port on this file's shape and conventions.
- `src/ports/llm-client.ts` — `ClassifyResult` interface gets a new `facts?` field; existing consumers ignore it.
- `src/core/classifier/prompt.ts` lines 47-83 — prompt extension lives here. Preserve the 15K char truncation and JSON validators.
- `src/core/storage/sqlite-session-store.ts` — pattern for the new `sqlite-fact-store.ts`; especially the migration and the atomic insert transaction.
- `src/core/recall/recall-service.ts` — pattern for `fact-recall-service.ts`. Reuse `tokenize.ts` and `score-keyword.ts`.
- `src/mcp/server.ts` lines 76-108 — register `recall_facts` and `get_fact_history` next to existing tools.
- `src/shared/types.ts` lines 18-34 — add `Fact` interface near `Session`.

## Verification

Each phase ships with tests; ship-readiness for the FactStore as a whole:

1. **Unit:** classifier prompt extension produces well-formed `facts[]` against fixture transcripts. Fact extraction pure function maps `ClassifyResult` → `Fact[]` deterministically. Supersedence logic correctly marks predecessors on collision.
2. **Integration:** real SQLite + real Ollama, ingest a fixture transcript end-to-end, assert facts row appears with correct subject/predicate, assert `recall_facts(subject, predicate)` returns it, assert second ingest with different value supersedes first.
3. **MCP smoke:** spawn the daemon, call `recall_facts` over MCP stdio, assert JSON shape matches contract.
4. **Backfill dry-run:** `scripts/backfill-facts.ts --limit 10 --dry-run` against production DB copy, eyeball the extracted facts for sanity before live run.

---

## Open Questions (defer until implementation)

These do not block shipping the design but should be revisited during Phase B.2:

- Predicate vocabulary: should the closed list ship in the prompt or be config-driven? Lean prompt for v1, config for v2 if the vocabulary drifts per-domain.
- Should `kind: open` facts have their own resolution affordance (mark resolved without a supersedent)? Probably yes but punt to Phase C.
- Cross-runtime entity normalization: "mac-pro-llm-host" vs "macpro" vs "Mac Pro" — does the classifier normalize, or do we ship an alias table? Defer; let the data tell us how bad the problem is.
