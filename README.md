# nlm-memory

> Local-first memory OS for AI operators — one corpus across every runtime you use.

`nlm-memory` indexes every session from Claude Code, Codex, OpenCode, Hermes, Aider, and pi into a single searchable store on your machine. Three properties no competitor ships together:

1. **Cross-runtime reach.** Claude Code, Codex, and OpenCode ship today. Hermes, pi, and Aider follow the same adapter pattern. One index, every tool — not one per runtime.
2. **Editable timeline.** Sessions can be superseded, retired, or marked aborted. Memory is non-linear: patch history retroactively. No other memory layer lets you do this.
3. **97.2% R@5 baseline.** On a 14-month corpus, keyword recall surfaces the right session in the top 5 on 97.2% of evaluator queries. No fine-tuning, no cloud, no account.

Everything stays on your machine. No telemetry, no account required beyond your classifier of choice.

---

## Requirements

- **Node 20+**
- **[Ollama](https://ollama.com)** running locally with `nomic-embed-text` pulled:
  ```sh
  ollama pull nomic-embed-text
  ```
- **A classifier** — [DeepSeek](https://platform.deepseek.com) is recommended (fast, cheap, ~$0.002/session). Set `DEEPSEEK_API_KEY` in `~/.nlm/.env`. Ollama works offline with `NLM_CLASSIFIER=ollama`.

---

## Install

```sh
npm install -g github:pbmagnet4/nlm-memory-ts
nlm migrate
nlm install
```

`nlm install` writes a macOS LaunchAgent that starts the daemon on login and keeps it running. Open **http://localhost:3940/ui** — done.

To stop or remove:
```sh
launchctl stop com.github.pbmagnet4.nlm-memory   # stop without uninstalling
nlm uninstall                                    # remove the LaunchAgent entirely
```

---

## Wire to your AI agents (MCP)

Add to `~/.mcp.json` (or your editor's MCP config):

```json
{
  "mcpServers": {
    "nlm-memory": {
      "command": "node",
      "args": ["<path-to-global-npm>/lib/node_modules/nlm-memory/dist/cli/nlm.js", "mcp"]
    }
  }
}
```

Find the path with `npm root -g` — the full path is `$(npm root -g)/nlm-memory/dist/cli/nlm.js`.

Or use the runtime-specific connect commands:

```sh
nlm connect claude-code      # writes to ~/.mcp.json + installs hooks
nlm connect codex            # installs as a Codex marketplace plugin
nlm connect hermes           # writes to ~/.hermes/config.yaml (MCP)
nlm connect hermes-agent     # installs as a NousResearch Hermes plugin (hooks + MCP)
```

Once wired, agents can call `recall_sessions` (search past conversations) and `recall_facts` (pull structured facts like decisions and project state) automatically.

---

## What's inside

| Page | What it shows |
|---|---|
| **Live** | Sessions being written in real time, recent reads and decisions |
| **Pulse** | System health — coherence, runtimes, stale entities, recent sessions |
| **River** | Full session timeline with density controls |
| **Thread** | Per-entity conversation history |
| **Search** | Keyword, semantic, or hybrid recall |
| **Recall** | Adoption telemetry — is the memory system actually being used? |
| **Settings** | Sources, providers, classifier, data backup/restore |

---

## How it differs from mem0 and graphiti

- **Unit of memory:** whole sessions with extracted markers (decisions, open questions, entities), not individual facts or graph edges.
- **Audience:** you querying your own past work, not an embedded SDK for app developers.
- **Cross-runtime:** one corpus across Claude Code, Codex, OpenCode, Hermes, and more. Competitors target one runtime.
- **Editable timeline:** sessions can be superseded, retired, aborted. No other tool lets you retrofit memory — a record from 6 months ago can be corrected today.
- **Local-only:** no hosted offering, no telemetry, no vendor dependency.

---

## Development

```sh
git clone https://github.com/pbmagnet4/nlm-memory-ts
cd nlm-memory-ts
npm install        # install dependencies
npm run build      # compile dist/ — commit the result, it ships in the repo
npm run dev        # hot-reload daemon
npm run ui:dev     # hot-reload UI at localhost:5173 (proxies /api to :3940)
npm test           # unit + integration tests
npm run typecheck
```

`dist/` is committed to the repo so `npm install -g github:…` works without a build step on the user's machine. Rebuild and commit `dist/` whenever you change `src/`.

Database lives at `~/.nlm/canonical.sqlite`. Override with `NLM_DB_PATH`.

---

## License

Apache 2.0 — see [LICENSE](LICENSE).
