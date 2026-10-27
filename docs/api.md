# MCP and HTTP reference

## MCP Tools

| Tool | What it does |
|---|---|
| `recall_sessions` | Compact session discovery: five hits and 8,000 characters per page by default. Relevant decisions/open questions, status, successor IDs, omission counts and source expansion pointers. Follow `nextCursor` for remaining candidates. The default ten-candidate search window preserves existing ranking; `candidateLimit` widens it explicitly. [Paging contract](context-retrieval.md#session-search-pages). |
| `recall_context` | Preferred compact retrieval: tenant/workstream-scoped facts and source passages, complete exact-value conflict probes, and explicit partial/deadline coverage. See [context retrieval](context-retrieval.md) and [measured limitations](memory-retrieval-results.md). |
| `get_session` | Compact context by default; add `query` for matching passages. Explicit `view="transcript"` returns bounded original-text pages with continuation arguments. Includes supersedence and outcome context. |
| `recall_facts` | Search structured facts: decisions, open questions, project state. Filterable by subject, predicate, kind and canonical property (unreleased source). |
| `get_fact_history` | Full version history of one fact — how a decision evolved over time. |
| `cite_session` | Mark a session as explicitly referenced. Drives the `useful_hit_rate` metric and the future learned reranker. |

| `mark_superseded` | Retroactively retire a stale session and point it at the newer one that replaces it. The editable-timeline write path — see [docs/supersedence.md](supersedence.md). |
| `report_outcome` | Write an outcome signal (pass / fail / fix / exhausted) for a session or correlation key. The contract surface for deterministic producers: CI, quality gates, automation platforms. Agents rarely self-report; wire your pipelines to this, not your prompts. |
| `recall_code` | Semantic search over captured code exemplars — "code that passed/failed a gate like this task." Returns positives plus labeled negatives. Registered only when `NLM_CODE_EXEMPLARS_ENABLED=1`. |

---

**When to call `cite_session`:** Call it when a surfaced session actually changes what you say — you referenced it explicitly, it corrected a decision, or you called `get_session` to read the full body. Do not call it for sessions you scanned and discarded. The Stop hook auto-detects citation when a session ID appears verbatim in your response; `cite_session` covers the deliberate case where the session influenced your reasoning without being quoted directly. Both paths feed the same signal loop.

## REST API

Daemon binds `127.0.0.1:3940` (override with `NLM_PORT`). Selected endpoints:

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/health` | Host-only | Liveness probe: version, warmup + embedding-lane state, corpus stats, `update: {current, latest, behind}` from the daily npm check, and `job: {name, state, processed, total, startedAt, lastAdvanceAt, restarts, restartsTotal} \| null` — the daemon-supervised `reprocess` run (null when idle: never started, or the daemon just restarted, since the supervisor holds no state across restarts). `restarts` is the restarts-without-progress counter (resets on any advance); `restartsTotal` is the run's lifetime respawn count, never reset — it's the one to watch for OOM churn on a run that keeps making progress between crashes. |
| GET | `/api/recall` | Bearer/Origin | Hybrid recall — `?q=`, `?mode=keyword\|semantic\|hybrid`, `?limit=`, `?include_superseded=true` (default off; opt-in to surface overturned sessions down-ranked, badged with `superseded_by`). Each result carries `status` + `superseded_by`. |
| GET | `/api/recall/stats` | Bearer/Origin | 7-day stats: total, hit_rate, useful_hit_rate, top queries |
| GET | `/api/recall/recent` | Bearer/Origin | Last N recall events for live tail/telemetry |
| GET | `/api/recall/cite-stats` | Bearer/Origin | Citation rate over `?days=` |
| GET | `/api/session/:id` | Bearer/Origin | Full session body + supersedence links |
| GET | `/api/recall/facts` | Bearer/Origin | Structured fact search; includes `hint` field when empty |
| GET | `/api/facts/history` | Bearer/Origin | Version chain for one fact |
| GET | `/api/dataset` | Bearer/Origin | Full session list for the UI dataset view |
| GET | `/api/live/recent-writes` | Bearer/Origin | Live tail of ingested sessions |
| GET | `/api/data/backup` | Bearer/Origin | Streaming SQLite snapshot download |
| POST | `/api/data/restore` | Bearer/Origin | Stage a snapshot for apply-on-restart |
| POST | `/api/citation/explicit` | Bearer/Origin | Log an explicit session citation (the route backing the `cite_session` MCP tool; payload `{id, conversation_id?, reason?}`) |
| POST | `/api/hook/pre-compact` | Bearer/Origin | Hook endpoint; flushes the surfaced-IDs memo |
| ALL | `/mcp` | Bearer required | Streamable-HTTP MCP transport — the default for every runtime; stateless, team resolved from the token |
| GET | `/api/recall-code` | Bearer/Origin | Semantic code-exemplar search — `?q=`, `?repo=`, `?lang=`, `?k=`, `?negatives=0`. Requires `NLM_CODE_EXEMPLARS_ENABLED=1`. |
| POST | `/api/exemplar` | Bearer/Origin | Direct code-exemplar push (capture also happens automatically from code-bearing signals). Requires the flag. |
| POST | `/api/jobs/reprocess` | Bearer/Origin | Start a daemon-supervised `reprocess` run (body: optional `{args: string[]}`, forwarded verbatim as CLI flags). 202 + snapshot on start, 409 + snapshot if one's already active. Backs `nlm reprocess --daemon`. |
| DELETE | `/api/jobs/reprocess` | Bearer/Origin | Stop the active supervised run (no-op if idle/already terminal). 200 + snapshot. |

Host and Origin checks protect local API access. Authentication depends on local, cookie or hosted mode; `/mcp` requires a bearer token. See [Security](../SECURITY.md) before configuring remote access.
