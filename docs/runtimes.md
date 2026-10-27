# Runtime integrations

Capture, MCP access and automatic hooks are separate capabilities. A registered source lets NLM read sessions; it does not necessarily install an MCP client or inject context into the originating runtime.

| Runtime | Connection command | Capture | What the command installs/registers |
|---|---|---|---|
| Claude Code | `nlm connect claude-code` | Runtime JSONL sessions | MCP configuration and lifecycle hooks. |
| Codex CLI | `nlm connect codex` | Runtime JSONL sessions | Marketplace plugin with MCP/hooks; `--with-hooks` adds the absolute-path fallback. |
| Hermes WebUI | `nlm connect hermes` | Session files | MCP server configuration. |
| Hermes Agent | `nlm connect hermes-agent` | Agent database | Lifecycle hook plugin; command output also points to `nlm connect hermes` for MCP wiring. |
| Cursor | `nlm connect cursor` | IDE database | Source registration; `--with-rules` adds a workspace rule nudge. It does not install an MCP client configuration. |
| Windsurf | `nlm connect windsurf` | IDE databases | Source registration; `--with-rules` adds a global rule nudge. Configure an MCP client separately. |
| OpenCode | `nlm connect opencode` | Runtime database | Source registration; `--with-rules` adds a global rule nudge. Configure an MCP client separately. |
| Muse | `nlm connect muse` | Runtime session files | Source registration; restart the daemon to scan it. |
| pi.dev | `nlm connect pi` | Runtime session files | Input extension for context delivery. [Extension reference](../nlm/README.md). |
| Aider | Configure its capture source | Chat-history file | Capture only; no native NLM MCP/hook connection. |

Use each command's `--help` for path overrides and supported options. A static rule asks the agent to call recall; it does not guarantee the agent will do so or that tools have been configured.

## MCP transport

The daemon exposes Streamable HTTP at `http://127.0.0.1:3940/mcp`. Configure a client with that URL and an `Authorization: Bearer` header using the local `NLM_MCP_TOKEN`. Prefer a client's supported secret/environment mechanism over copying a token into a shared file. Commands that install MCP configuration default to HTTP.

Stdio remains available through `nlm mcp`, with command-specific `--stdio` options where supported. It opens the local database directly and binds to the default team. HTTP resolves the team from the bearer token. [API reference](api.md) · [Security](../SECURITY.md).

## Automatic context delivery

Claude Code, Codex CLI, Hermes Agent and pi have hook/extension integrations. Exact lifecycle events depend on the runtime. Per-prompt ambient recall is off by default on fresh installs; explicit, task-directed pulls remain available through MCP.

The July 2026 consumption measurements favored task-directed pulls in that recorded setup; they do not guarantee the same result for another agent or corpus. [Evaluation context](evaluations.md).

Hooks fail open so a recall failure does not block the calling agent. Consult the [hook reference](hooks.md) and digest liveness reporting when debugging a silent integration. Parent/subagent relationships are derived from runtime metadata during capture where supported.
