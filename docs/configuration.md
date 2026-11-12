# Configuration
### Environment variables

| Var | Default | What |
|---|---|---|
| `NLM_PORT` | `3940` | Daemon bind port (loopback only) |
| `NLM_DB_PATH` | `~/.nlm/canonical.sqlite` | SQLite canonical store location |
| `NLM_HOOK_MODE` | `live` | `live` injects pointer block; `shadow` logs without injecting |
| `NLM_HOOK_RECALL_TIMEOUT_MS` | `4000` | Hook-side budget for the daemon recall call. Must stay below `NLM_HOOK_DEADLINE_MS` and above the daemon's embed deadline or the pointer block silently empties (#396). |
| `NLM_HOOK_DEADLINE_MS` | `6000` | Outer wall-clock deadline for the recall + gate stages of a hook fire. Fail-open on expiry. |
| `NLM_HOOK_PROMPT_RECALL` | `(unset = off)` | Per-prompt ambient recall. Off by default (pull-first); set `on` to inject a pointer block on every prompt. `off` disables explicitly. |
| `NLM_HOOK_LOG` | `~/.nlm/hook-log.jsonl` | Hook fire log; powers digest's liveness alert |
| `NLM_USEFUL_HIT_LOG` | `~/.nlm/useful-hit-log.jsonl` | Citation/useful-hit ledger |
| `NLM_QUERY_LOG` | `~/.nlm/query-log.jsonl` | Recall query telemetry |
| `NLM_CITATION_LOG` | `~/.nlm/citation-log.jsonl` | Stop-hook citation events |
| `NLM_MISS_LOG` | `~/.nlm/miss-log.jsonl` | Stop-hook miss events — sessions the agent explicitly fetched via `get_session`/`cite_session` that the hook never surfaced. Reviewed via `nlm misses`. |
| `NLM_MISS_LOG_ENABLED` | `true` | Set to `0` to disable miss-log emission entirely. |
| `NLM_MCP_TOKEN` | auto-generated | Bearer credential for `/mcp` and authenticated API modes; see [Security](../SECURITY.md) |
| `NLM_MCP_CONFIG` | `~/.mcp.json` | Path the `connect`/`disconnect` commands modify |
| `NLM_CLASSIFIER` | `ollama` | `ollama` (local, default), `deepseek`, `openai`, `anthropic`, `openrouter`, or `openai-compatible` |
| `NLM_CLASSIFIER_MODEL` | `qwen3.5:4b` | Model id for the chosen provider. `qwen3.5:4b` (Q4_K_M, 4.7B) is the recommended local default. For measured tier expectations, see [docs/classifier-tiers.md](classifier-tiers.md). |
| `NLM_OLLAMA_URL` | `http://localhost:11434` | Override Ollama endpoint |
| `NLM_CODE_EXEMPLARS_ENABLED` | — | Set to `1` to enable the code-exemplar lane (capture from code-bearing signals + the `recall_code` tool/routes). Off by default. |
| `NLM_EMBED_API_KEY` | — | API key for the `openai` embedder provider, both lanes. Environment only: Settings → Embedder never accepts or stores a key (a key stored by an older version is still read until you clear it there). Inject it from your secret manager at launch. |
| `NLM_CODE_EMBED_MODEL` | `hf.co/awhiteside/CodeRankEmbed-Q8_0-GGUF` | Ollama model for code-exemplar embeddings (768-dim). Only used when the exemplar lane is enabled. Switching it from Settings → Embedder rebuilds the code vectors. |
| `NLM_PROPERTY_ASSOCIATIONS` | off | Opt into property-aware unresolved-fact isolation and repository-origin session associations; prerelease 0.21.21-rc.1. |
| `NLM_PROPERTY_INFERENCE` | off | Experimental automatic fact owner attribution only; keep off (the conservative candidate proposes too few owners to evaluate). |
| `NLM_SESSION_PROPERTY_INFERENCE` | off | Experimental entity-name session references (ingestion and backfill); keep off until the session-lane evaluation passes. Requires `NLM_PROPERTY_ASSOCIATIONS=1`. |
| `NLM_ADAPTERS` | all | Comma-separated allowlist of adapters to enable |
| `DEEPSEEK_API_KEY` | — | Required only when classifier=deepseek |
| `NLM_DISABLE_UPDATE_CHECK` | — | Set to `1` to disable the daily npm-registry update check |
| `NLM_RECALL_DECAY_HALF_LIFE_DAYS` | `180` | Half-life of the recency multiplier applied to recall scores. Older sessions score lower; defaults to 6 months. Set to `0` to disable recency weighting entirely. |
| `NLM_RECALL_DECAY_FLOOR` | `0.25` | Lower bound on the recency multiplier — even ancient sessions retain at least 25% of their raw score so a perfect-match old session can still surface. |
| `NLM_RECALL_REWRITE_DEFAULT` | `true` | Default value for the MCP `recall_sessions` `rewrite` parameter. When true, the service runs an LLM rewrite on vague natural-language queries before search. The HTTP hook caller bypasses rewrite regardless (hot-path protection). |
| `NLM_RECALL_REWRITE_TIMEOUT_MS` | `5000` | Per-call timeout for the rewrite LLM. Separate from the classifier timeout. |
| `NLM_FACT_CORROBORATION_BOOST_CAP` | `1.0` | Maximum multiplicative boost applied to fact recall scores based on how many sessions corroborate the same `(subject, predicate, value)`. Log-scale: count 2 is 1.30× at any cap ≥ 1.30, count 10 is 2.0× (capped). Default 1.0 disables the boost (the count is still returned on each hit): T527 measured −42.6 pts hybrid R@1 at the old 2.0 default with no citation upside — see `docs/eval/T527-corroboration-cap.md`. Set to e.g. `2.0` to opt back in. |
| `NLM_HOOK_INJECT_FACTS` | `true` | Whether to attach high-confidence facts about top-hit entities to the pointer block injected by the hook. Set to `0` to disable globally. |
| `NLM_HOOK_FACT_LIMIT` | `5` | Maximum number of facts in the "Known facts" section of the pointer block. |
| `NLM_HOOK_FACT_MIN_CORROBORATION` | `2` | Minimum number of sessions that must have asserted a fact before it qualifies for hook injection. Set to `1` to include single-source facts. |
| `NLM_HOOK_FACT_MIN_CONFIDENCE` | `0.7` | Minimum classifier confidence for a fact to qualify for hook injection. |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | — | Required for `nlm digest --telegram` |
| `NLM_ALERT_WEBHOOK` | — | Set to a URL to enable daemon self-reporting: version-drift and embedder-cold transitions POST a CloudEvents-shaped payload here. Unset means zero network calls. |
| `NLM_ALERT_WEBHOOK_TOKEN` | — | Optional bearer token sent as `Authorization: Bearer <token>` on every `NLM_ALERT_WEBHOOK` POST. Only used when the webhook is set. |
| `NLM_JOB_STALL_MINUTES` | `20` | Minutes a daemon-supervised `reprocess` run (see `POST /api/jobs/reprocess`) can go without a progress advance before the supervisor calls it stalled and fires `nlm.job.stalled` via `NLM_ALERT_WEBHOOK`. The same event type also fires with `reason: "exhausted"` (restart budget used up) and `reason: "spawn_failed"` (the child process itself never launched — EMFILE/ENOMEM/bad binary). |
| `NLM_WIKI_DIR` | — (opt-in, off by default) | The wiki projection is off unless this is set. When set, every `NLM_WIKI_INTERVAL_HOURS` the SQLite-backend daemon rolls up fact subjects that cleared the page threshold into a markdown tree at `<dir>/Memory`, reconciled against the previous run so an unchanged page writes zero bytes. Unset means no timer, no directory, no log line — an upgrade never surprises you with new files under your home directory. A failed run leaves the previous tree untouched and fires `nlm.wiki.projection_failed` via `NLM_ALERT_WEBHOOK`; a run whose written page count doesn't match what the corpus currently qualifies for fires `nlm.wiki.coverage_drift`. Postgres backend: not implemented, daemon never starts it. |
| `NLM_WIKI_INTERVAL_HOURS` | `6` | How often the wiki projection re-runs once `NLM_WIKI_DIR` is set. |
| `NLM_WIKI_MIN_FACTS` | `3` | Minimum current (non-superseded, non-retired) fact count a subject needs to earn a wiki page. |
| `NLM_WIKI_MIN_SESSIONS` | `3` | Minimum distinct contributing sessions a subject needs to earn a wiki page. |
| `NLM_WIKI_LINK_BASE` | `http://127.0.0.1:<NLM_PORT>` | Base URL a wiki page's session links point at. Override when the vault is synced somewhere the daemon's own loopback address won't resolve. |
| `NLM_CLEF_BASE_URL` | — (Clef off) | Base of the Clef "system one" endpoint. Point it at the classifier gateway or straight at an inference host (`http://127.0.0.1:8080`); unset means no caller has a judge and every Clef-backed job stays home. |
| `NLM_CLEF_PATH` | `/clef/v1/systemone` | Request path appended to that base. The gateway mounts Clef under a pass-through prefix; a direct server (oMLX, LM Studio) serves the bare `/v1/systemone`, so point it there. |
| `NLM_CLEF_MODEL` | `clef-oQ4e` | Model name sent in the request body. `clef-flash-oQ8e` is ~5x faster at slightly lower accuracy — the lane the relevance eval recommends for sampled jobs. |
| `NLM_CLEF_API_KEY` | — (no auth header) | Bearer token. Leave unset for a direct host on a trusted network: no `Authorization` header is sent at all. |
| `NLM_RELEVANCE_JUDGE` | off (`no measurement`) | Nightly Clef relevance-precision metric (T1782): samples the last 24 h of prompt-recall hook fires, judges each (prompt, injected memory) pair, and reports the kept share as `actual.relevancePrecision` on `GET /api/health/slo`. Metric only, never an injection gate; it rides the scheduler tick (once per 24 h, fired not awaited, behind the disk guard). |
| `NLM_RELEVANCE_SAMPLE` | `60` | Hook records sampled per night, taken on an even stride across the window. Each record contributes its injected memories, so a night is a couple of minutes of a local model. |
| `NLM_RELEVANCE_THRESHOLD` | `1.43` | Score at or above which a pair counts as relevant. Default is the tune-split fit for the `same` phrasing at 8 memories/call **on flash** — the base model's own fit is `1.47`, so pairing it with the default `NLM_CLEF_MODEL` is a deliberate, slightly looser starting point. The judge reads ~5 points low at it, so recalibrating is a config change — and if you change `NLM_RELEVANCE_CHUNK`, re-fit it: the absolute scale moves with the grouping. |
| `NLM_RELEVANCE_PHRASING` | `same` | Question wording: `same`, `dev` or `direct`. They correlate 0.95-0.99, so the choice barely matters — but the fitted threshold belongs to whichever one you picked. |
| `NLM_RELEVANCE_CHUNK` | `8` | Memories per Clef call. One prompt carried 29 and the call came back HTTP 413; 8 was the measured shape. |
| `NLM_RELEVANCE_STATE` | `~/.nlm/relevance-nightly.json` | When the job last *attempted* (not succeeded), so a night that fails against an offline judge costs one WARN a day instead of a retry every tick. |
| `NLM_RELEVANCE_DIR` | `~/.nlm/relevance` | Directory for the nightly `<UTC date>.jsonl` dump of scored pairs (prompt preview, memory id/label, score, kept, threshold, model) for recalibration against labels. Keeps 14 nights. |

### Changing the classifier from the UI

The CLI env-vars above are one path; the running UI is the other. **Settings → Providers** is a full CRUD list of LLM endpoints (Ollama, DeepSeek, OpenAI, Anthropic, OpenRouter, or any OpenAI-compatible endpoint such as LM Studio, llama.cpp, vLLM, text-generation-webui). Click **Add provider**, point it at your local server, hit **Save & test**. Then in **Settings → Classifier**, pick that provider and model. No env-var editing required, and the DeepSeek row can be disabled or deleted from the same screen.

Adapter source paths can be overridden individually: `NLM_CLAUDE_PROJECTS_PATH`, `NLM_CODEX_CONFIG`, `NLM_CURSOR_DB_PATH`, `NLM_HERMES_SESSIONS_PATH`, `NLM_HERMES_AGENT_DB_PATH`, `NLM_WINDSURF_USER_DIR`, `OPENCODE_DB_PATH`, `PI_SESSIONS_PATH`, `AIDER_CHAT_HISTORY_FILE`.

### Config file

`~/.nlm/.env` — autoloaded by every CLI command. Mode `0600`, owned by you, never readable by other users. The setup wizard writes the initial keys; you can edit it directly.

### Ports

| Port | Process | Bind | Override |
|---|---|---|---|
| `3940` | Daemon HTTP API + MCP | `127.0.0.1` only | `NLM_PORT` |
| `11434` | Ollama (embedding + local classifier) | localhost | `NLM_OLLAMA_URL` |

For data flow and access control, see [Security](../SECURITY.md).
