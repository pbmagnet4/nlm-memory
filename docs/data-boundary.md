# Data boundary

NLM is local-first. Your sessions, decisions, and recall index live in a single
SQLite database on your machine, served by a daemon bound to loopback only. By
default **nothing leaves the machine** — embeddings and classification run on a
local Ollama. The only ways data crosses the machine boundary are opt-in and
named below.

```
                 YOUR MACHINE  ── trust boundary ──
  +---------------------------------------------------------------------+
  |  AI runtimes            NLM daemon  (127.0.0.1:3940, loopback-only, |
  |  (Claude Code, pi,                   token-gated)                   |
  |   Codex, Hermes)        +------------------------------------------+|
  |      |  transcripts     |  HTTP / MCP                              ||
  |      v  (jsonl)         |     |                                   ||
  |   hooks --recall/ingest-->   recall  <----  SQLite ~/.nlm/canonical||
  |                         |     ingest  ---->  sessions | facts |    ||
  |                         |       |            exemplars | signals   ||
  |                         +-------|--------------------|-------------+|
  |                                 | embed / classify   |  LOCAL ONLY  |
  |                                 v                     |             |
  |                         Ollama (localhost:11434)      |             |
  |                         nomic-embed | qwen3.5:4b      |             |
  +---------------------------------|------------------------------------+
                                    |
        EGRESS  — only if you explicitly enable it, never by default:
            * Cloud classifier (NLM_CLASSIFIER=deepseek)
                -> api.deepseek.com   (sends full session content)
            * nlm digest --telegram
                -> Telegram API        (sends an activity summary)
```

## Defaults

| Function | Default | Where it runs |
|----------|---------|---------------|
| Embeddings | Ollama `nomic-embed-text` | local (`localhost:11434`) |
| Classification | Ollama `qwen3.5:4b` | local |
| HTTP / MCP API | bound `127.0.0.1`, loopback-only middleware, `NLM_MCP_TOKEN`-gated | local |
| Storage | SQLite | local file (`~/.nlm/canonical.sqlite`) |

## Opt-in egress

- **Cloud classifier.** Setting `NLM_CLASSIFIER=deepseek` sends full session
  content to `api.deepseek.com` for classification. The daemon prints a one-line
  egress notice at startup whenever a cloud classifier is active. Set
  `NLM_CLASSIFIER=ollama` (the default) to keep classification local.
- **Telegram digest.** `nlm digest --telegram` sends an activity summary to the
  Telegram API. It is a manual command; nothing posts automatically.

No telemetry, no analytics, no phone-home. The update check is the only network
call the daemon makes on its own, and it sends nothing but a version query.
