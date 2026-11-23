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

## Voice samples

With `NLM_VOICE_ENABLED=1` (default off) the daemon keeps a second corpus:
`writing_samples` — prose the person wrote and then shipped, approved or threw
away (a `rejected` sample is kept so recall can show what to avoid, and it is
held to exactly the same boundary as a published one), plus provenance (URL,
channel, outcome), and nothing else. It is the recall corpus
behind `recall_voice`, and it is the person's own words, so it is held to the
same boundary as a published post and one tighter:

- **Local, tenant-scoped, loopback-served.** Same database file, same
  `tenant_id` filter as every other corpus, and an `install_scope` the daemon
  stamps itself — a caller cannot ask for another install's samples.
- **Never exported.** Samples are not in the dataset projector, not in digests,
  not in any telemetry (there is none) and not in any export path. The recall
  tool hands examples to the agent drafting in your session; that is the only
  way out of the store.
- **Embedding is the only computation over the text**, and it goes to whichever
  embedder you configured — the same call sessions and facts already make. The
  voice lane adds no endpoint and no new egress path. The `context` column (what
  a post replied to) is never embedded or searched.
- **Off means off.** The tables are created either way so migrations stay
  idempotent, but with the flag unset nothing is written to them and nothing
  reads them.
