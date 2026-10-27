# Runtime integrations

## Runtimes

One corpus across the adapters listed below. Capture, MCP access and automatic hooks are different capabilities; Aider is capture-only. **Automatic context injection via hooks** ships on four (Claude Code, Codex CLI, Hermes Agent, pi.dev). Cursor, Windsurf, and OpenCode receive an optional static rules-file nudge (`nlm connect <runtime> --with-rules`) that instructs the agent to call `recall_sessions` on history-flavored prompts — those runtimes don't expose a pre-prompt hook today, so a rules nudge is the closest equivalent. Aider is ingest-only. `nlm connect` wires whichever surface the runtime supports:

| Runtime | Connect | Sessions read from | Hooks |
|---|---|---|---|
| **Claude Code** | `nlm connect claude-code` | `~/.claude/projects/**/*.jsonl` | 5 hooks: UserPromptSubmit, SessionStart, SessionEnd, Stop, PreCompact |
| **Codex CLI** | `nlm connect codex` | `~/.codex/sessions/` | Marketplace plugin (UserPromptSubmit + Stop) |
| **Hermes** (WebUI) | `nlm connect hermes` | `~/.hermes/sessions/` | MCP only (writes the MCP server block to `~/.hermes/config.yaml`) |
| **Hermes Agent** (NousResearch CLI) | `nlm connect hermes-agent` | `~/.hermes/state.db` | 6 hooks: pre_llm_call, post_llm_call, on_session_start/end/finalize/reset (Python plugin in `~/.hermes/plugins/nlm-memory/`) |
| **Cursor** | `nlm connect cursor [--with-rules]` | Cursor IDE chat DB | MCP + optional rules nudge (workspace `.cursor/rules/nlm-recall.mdc`) |
| **Windsurf** | `nlm connect windsurf [--with-rules]` | Windsurf user dir | MCP + optional rules nudge (`~/.codeium/windsurf/memories/global_rules.md`) |
| **OpenCode** | `nlm connect opencode [--with-rules]` | `~/.local/share/opencode/` | MCP + optional rules nudge (`~/.config/opencode/AGENTS.md`) |
| **Aider** | adapter active (ingest only) | `AIDER_CHAT_HISTORY_FILE` | No native MCP, no hooks — sessions are read into the corpus but Aider cannot call recall back |
| **Muse** | `nlm connect muse` | `~/.local/share/muse/sessions/` | Capture; connect registers the source |
| **pi.dev** | `nlm setup` (auto) or `nlm connect pi` | `~/.pi/agent/sessions/**/*.jsonl` | 1 hook: input (prepend via transform) |

`nlm disconnect <runtime>` reverses any of the above.

---

## How recall works

Two delivery paths. They share the same index.

### 1. Hooks — automatic context injection

Hooks deliver memory into agent context. Four runtimes ship hooks today: Claude Code (five-hook lifecycle), Codex CLI (UserPromptSubmit + Stop via the marketplace plugin), Hermes Agent (six parallel hooks), and pi.dev (one `input` hook via [nlm/](../nlm/README.md)). Cursor, Windsurf, and OpenCode don't expose a pre-prompt hook today, so the `--with-rules` install path drops a static rules snippet that asks the agent to call `recall_sessions` itself on history-flavored prompts (see [docs/hooks.md](hooks.md) for the snippet). Full lifecycle, modes, logging surface, and the daily liveness canary documented in [docs/hooks.md](hooks.md).

On fresh installs, the **SessionStart** hook injects the pointer block at conversation open. The **UserPromptSubmit** (per-prompt) lane is off by default: measured pulls are 72.4% useful vs 18.2% ambient on the same judge (see [reports/usefulness/2026-07-03-consumption-measurements.md](../reports/usefulness/2026-07-03-consumption-measurements.md)), so pull-first via the recall MCP tools is the recommended posture. Set `NLM_HOOK_PROMPT_RECALL=on` to re-enable per-prompt injection.

**Claude Code** — five hooks written to `~/.claude/settings.json` via `nlm connect claude-code`:

| Event | What NLM does | Mode |
|---|---|---|
| **UserPromptSubmit** | Score the prompt, silently prepend pointer block listing 0–3 most likely-relevant prior sessions | off by default (pull-first); set `NLM_HOOK_PROMPT_RECALL=on` to enable |
| **SessionStart** | Cold-start agents (cron, background) hit this; same pointer-block delivery without a user prompt, plus a "Known failure modes for this repo" block when signals data exists (see Signals below) | live by default |
| **SessionEnd** | Delete the per-conversation memo on session close so state files don't accumulate | always on |
| **Stop** | Scan the model's response for citations of surfaced session IDs → updates `useful_hit_rate` and builds the reranker training substrate | always on |
| **PreCompact** | Flush the per-conversation surfaced-IDs memo so post-compaction recalls aren't gated | always on |

**Hermes Agent** — six hooks installed to `~/.hermes/plugins/nlm-memory/` via `nlm connect hermes-agent`. All calls are fire-and-forget except `pre_llm_call`, which returns a context string for injection:

| Hook | What NLM does | Blocks turn? |
|---|---|---|
| **pre_llm_call** | POST prompt to daemon → inject pointer block of relevant prior sessions into context | yes (returns context string) |
| **post_llm_call** | POST assistant response to daemon → citation scan, `useful_hit_rate` update | no |
| **on_session_start** | Signal session open → daemon initialises per-session memo | no |
| **on_session_end** | Signal session close → daemon flushes memo | no |
| **on_session_finalize** | Signal transcript finalised → triggers async classifier run | no |
| **on_session_reset** | Signal session reset → daemon clears per-session state | no |

**pi.dev** — one `input` hook registered via `nlm connect pi`. Pi's extension API only exposes `input`, so transcript ingestion is handled separately by the passive adapter scanning `~/.pi/agent/sessions/`:

| Hook | What NLM does | Blocks turn? |
|---|---|---|
| **input** | Score user message → if relevant sessions found, prepend pointer block to the prompt text via `{ action: "transform" }` | yes (returns transformed text) |

Parent-to-subagent links need no hook: the adapter derives them from the runtime session id at ingest, so subagent threads stay coherent with zero per-dispatch overhead. All hooks fail open: any daemon error yields a clean exit and never blocks the model. Switch Claude Code hooks to **shadow** mode (log-only, no injection) with `NLM_HOOK_MODE=shadow`.

### 2. MCP — explicit tools any agent can call

**Streamable-HTTP `POST /mcp` is the default transport on every runtime.** `nlm connect <runtime>` writes it for you:

```json
{ "type": "http", "url": "http://127.0.0.1:3940/mcp",
  "headers": { "Authorization": "Bearer ${NLM_MCP_TOKEN}" } }
```

One daemon-backed server answers every session on every surface. The endpoint is stateless — a fresh transport and server per request, no session affinity — so it scales from a single laptop to a hosted multi-tenant deployment without changing shape, and the team is resolved from the bearer token rather than assumed. Nothing but the daemon touches the corpus.

Stdio remains available via `nlm connect <runtime> --stdio`. Its one advantage is that it builds its own stack and so works with the daemon stopped. The trade is real: a process per session, each opening the SQLite corpus directly, and no multi-tenancy (the stdio path is pinned to the single local team). Prefer HTTP unless you specifically need to run without a daemon.

Re-running `nlm connect` on an install that predates this default rewrites the old stdio block in place, so upgrades carry over rather than silently keeping the per-session shape.
