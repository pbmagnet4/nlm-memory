# Team NLM Table Census (M1 artifact)

Dispositions per program spec §2: **STAMP** = carries `tenant_id NOT NULL`; **DERIVE** = keyed by a stamped parent's id, only read through it; **NEUTRAL** = tenant-free with rationale.

| Table | Disposition | Rationale / parent |
|---|---|---|
| sessions | STAMP | corpus |
| facts | STAMP | corpus |
| code_exemplars | STAMP | corpus |
| signals | STAMP | corpus |
| workstreams | STAMP | corpus |
| sources | STAMP | per-tenant registry (spec §2) |
| providers | STAMP | per-tenant registry (spec §2) |
| entities | STAMP | spec §2 — composite PK (tenant_id, canonical), Task 3 |
| entity_variants | STAMP | variant PK collides across tenants; re-keyed with entities (Task 3) |
| session_entities | STAMP | composite FK to re-keyed entities (Task 3); tenant always equals its session's |
| workstream_entities | STAMP | composite FK to re-keyed entities (Task 3) |
| markers | DERIVE | via sessions.id (ON DELETE CASCADE); read only through session joins |
| session_edges | DERIVE | both endpoints are sessions; cross-tenant edges impossible once M2 enforces writes |
| session_chunk_map | DERIVE | via sessions.id |
| session_embeddings | DERIVE | vector-path rule resolves ids against stamped sessions |
| session_embedding_chunks | DERIVE | via sessions.id |
| fact_embeddings | DERIVE | via facts.id |
| code_exemplar_embeddings | DERIVE | via code_exemplars.id |
| code_exemplars_vec | DERIVE | sqlite-vec shadow of code_exemplars |
| sessions_fts | DERIVE | FTS shadow of sessions |
| actions | DERIVE | via target session/entity rows; operator-overlay log |
| adapter_state | NEUTRAL | local ingest cursor state; hosted ingest is webhook-push (spec §8) |
| embedding_config | NEUTRAL | per-database embedder identity, not corpus content |
| schema_migrations | NEUTRAL | migration bookkeeping |
| teams | NEUTRAL | the tenancy registry itself (created in Task 2) |
| team_tokens | NEUTRAL | credential registry, keyed by team_id FK (created in Task 2) |

Transient `_new` rebuild tables (`sessions_new`, `sources_new`, `actions_new`, `session_edges_new`) are excluded: they exist only inside a single migration's rebuild transaction.
