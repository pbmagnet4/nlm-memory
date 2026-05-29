# nlm-memory Hermes Agent plugin

This directory is the [NousResearch Hermes Agent](https://github.com/NousResearch/hermes-agent) plugin distribution surface for nlm-memory.

## Install

Prerequisite: `npm install -g nlm-memory` (puts `nlm` on PATH; the MCP server spawns `nlm mcp`).

```bash
# Recommended — uses nlm connect to copy the plugin and enable it
nlm connect hermes-agent

# Or manually
cp -r plugin-hermes-agent ~/.hermes/plugins/nlm-memory
hermes plugins enable nlm-memory
nlm connect hermes          # also writes the MCP server entry to ~/.hermes/config.yaml
```

## What this ships

- **`plugin.yaml`** — Hermes plugin manifest (name: `nlm-memory`, kind: `memory`)
- **`__init__.py`** — Python shim that registers 6 lifecycle hooks; all delegate to the local nlm daemon at `http://localhost:3940`

## How it works

| Hermes hook | Action |
|---|---|
| `pre_llm_call` | Keyword-recalls up to 3 relevant prior sessions; injects them as context above the user message |
| `post_llm_call` | Scans the assistant response for cited session IDs and logs prose citation events |
| `on_session_start` | No-op (memo is created lazily on first recall hit) |
| `on_session_end` | Clears the per-session surfaced-ID memo |
| `on_session_finalize` | Clears the per-session surfaced-ID memo |
| `on_session_reset` | Clears the per-session surfaced-ID memo |

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `NLM_DAEMON_PORT` | `3940` | Port the nlm daemon listens on |

## Daemon required

The plugin delegates entirely to the nlm daemon. Start it with `nlm start` or `nlm install` (macOS LaunchAgent). If the daemon is unreachable, every hook silently returns `None` — the agent loop is never blocked.

## Uninstall

```bash
nlm disconnect hermes-agent
```
