# nlm-memory pi.dev extension

This directory is the pi.dev distribution surface for nlm-memory. Pi exposes
hooks as a TypeScript extension API (`pi -e <path>`), not config-file hooks
like Claude Code or Codex, so the install surface is a single bundled
extension module.

## Install

Prerequisite: `npm install -g nlm-memory` (puts `nlm` on PATH; the daemon
must be running on `localhost:3940`).

```bash
nlm connect pi
```

That appends this directory's absolute path to `packages` in
`~/.pi/agent/settings.json`. Pi auto-loads it on next start via the
`pi.extensions` field declared in this package's `package.json` (which
points at `scripts/nlm-extension.mjs`). No `-e` flag required at the
prompt.

Reverse with `nlm disconnect pi`.

Manual fallback if you'd rather not edit settings.json:

```bash
pi -e "$(npm root -g)/nlm-memory/plugin-pi/scripts/nlm-extension.mjs"
```

## What ships

- **Input hook** — on every user prompt, calls the local daemon's
  `/api/recall?mode=keyword` endpoint, runs the same generative/evaluate
  gate as the Claude Code hook, and prepends a "Possibly-relevant prior
  sessions" pointer block to the prompt via pi's `{ action: "transform" }`
  result. Capped at 3 hits per fire and 10 per conversation; per-conversation
  memo lives in `~/.nlm/hook-state/<sessionId>.json` (shared with Claude
  Code). Fail-open: any error returns `{ action: "continue" }` so a recall
  failure can never block or alter your prompt.

## What doesn't

- **No stop-hook equivalent.** The passive pi adapter
  (`src/core/adapters/pi.ts`) already polls `~/.pi/agent/sessions/**/*.jsonl`
  and ingests completed sessions on its own schedule — what Claude's
  stop-hook does inline.
- **No `nlm connect pi` wrapper yet.** Install is the manual `pi -e` line
  above.

## Modes

Same env vars as the Claude Code hook:

- `NLM_HOOK_MODE=shadow` (default) — log what would be injected to
  `~/.nlm/hook-log.jsonl` but return `continue`. Use this to validate
  recall quality on real prompts before flipping live.
- `NLM_HOOK_MODE=live` — actually prepend the pointer block to your
  prompt.
- `NLM_PORT=3940` — daemon port override.
- `NLM_MCP_TOKEN` — bearer token if your daemon enforces it (auto-loaded
  from `~/.nlm/.env` on first input event).

## Building

```bash
npm run build:codex-plugin
```

Bundles `src/hook/pi-extension.ts` to `plugin-pi/scripts/nlm-extension.mjs`
via the same esbuild pipeline that builds the Claude Code hook scripts.
