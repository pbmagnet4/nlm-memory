## Agent self-improvement signals

NLM can ingest structured feedback events (`nlm.signal`) from any tool in your agent stack -- quality gates, eval runners, code reviewers, test harnesses -- and surface the aggregated failure patterns back to the agent at session start. Over time the agent learns which steps tend to fail for a given repo and model, without any external service.

### Payload contract

```jsonc
{
  "v": 1,
  "kind": "gate" | "eval" | "review" | "test",  // required
  "outcome": "pass" | "fail" | "fix" | "exhausted",  // required
  "producer": "quality-gate",   // defaults to "unknown"
  "model": "qwen3-coder",       // defaults to "unknown"
  "repo": "/path/or/name",      // defaults to "unknown"
  "detail": { "step": "types", "files": ["a.ts"], "attempt": 2 },
  "session": "<session-id-if-known>",
  "ts": "2026-06-09T18:00:00.000Z"  // defaults to now
}
```

`kind` and `outcome` are the only required fields; invalid values are rejected with `400`. `install_scope` is stamped server-side -- do not send it.

### Transports

**HTTP (any producer)**

```js
await fetch("http://localhost:3940/api/signal", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    kind: "gate", producer: "my-tool", outcome: "fail",
    model, repo, detail: { step: "types" }, ts: new Date().toISOString(),
  }),
});
```

Rides the standard `/api/*` loopback gate. When the daemon runs with `NLM_UI_AUTH=cookie`, send `Authorization: Bearer $NLM_MCP_TOKEN`.

**Session-embedded (pi.dev)**

Pi producers call `pi.appendEntry("nlm.signal", payload)` inside an extension. This writes:

```json
{ "type": "custom", "customType": "nlm.signal", "data": { ...payload } }
```

to the session `.jsonl`. NLM's pi adapter recognises the `nlm.signal` customType and the scheduler drains it during normal ingest -- no HTTP call required.

### Failure-mode recall

NLM aggregates signals into failure modes per `(repo, model)` pair. A mode surfaces when its fail-rate reaches 20% or higher over at least 10 events in a trailing 14-day window. At session start the Claude Code `SessionStart` hook injects a "Known failure modes for this repo" block into the agent prompt automatically (repo-scoped). Any harness can fetch the same data directly:

```
GET /api/signals/failure-modes?repo=<repo>&model=<model>
```

### Outcome rollup

Signals also feed a corpus-internal outcome verdict per session, derived from later independent evidence only: a reported signal, supersession, a continuation edge, or nothing yet (`unobserved`, shown honestly). Never the agent's own opinion of its work, and never an LLM's grade of it. `get_session` returns the verdict with its evidence; `nlm digest` reports 30-day coverage. The design is deliberately conservative: a session with no downstream evidence stays `unobserved` instead of guessing.

### Inspection

```sh
nlm improve   # prints failure modes + recommendations for the current repo
```

The UI **Recall** page also has a failure-modes panel. NLM surfaces findings and recommendations only -- it never acts on them.

### Configuration and privacy

| Var | Default | What |
|---|---|---|
| `NLM_SIGNALS_ENABLED` | `1` (on) | Set to `0` to disable signal ingest entirely |
| `NLM_SIGNAL_RETENTION_DAYS` | `90` | Raw signals older than this are pruned |

Signals are stored locally and stamped with a per-install ID from `~/.nlm/install-id`. Optional code embeddings, evaluation tools and notification integrations can send data to configured endpoints; see [Security](../SECURITY.md).

### Reference producer

The pi `quality-gate` extension (in the `pi-sandbox` repo) is a ~10-line integration that emits `nlm.signal` per gate step and again on retry exhaustion. It is the canonical example of the session-embedded transport.

### Code exemplar recall

Built on the signals lane: a code-bearing signal — one carrying a `git_sha` or `detail.code` with a `pass`/`fail`/`fix` outcome — is captured as a **code exemplar**, a concrete chunk that worked (or didn't) for a task. At implementation time an agent calls `recall_code` to pull "code that passed a gate like this," with positives ranked first and labeled negatives surfaced as anti-patterns.

Off by default — enable with `NLM_CODE_EXEMPLARS_ENABLED=1`. Capture rides the existing `/api/signal` path (no separate producer wiring); retrieval is exposed on every transport: the `recall_code` MCP tool (stdio and `/mcp`), `GET /api/recall-code`, and the `nlm recall-code "<task>"` CLI. Code embeddings use CodeRankEmbed (`hf.co/awhiteside/CodeRankEmbed-Q8_0-GGUF` via Ollama, 768-dim; override with `NLM_CODE_EMBED_MODEL`). Works on both the SQLite and Postgres+pgvector backends.
