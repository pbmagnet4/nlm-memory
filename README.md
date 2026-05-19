# nle-memory

> Local-first memory operating system for AI operators. Treats AI reasoning as a non-linear editing problem.

`nle-memory` indexes sessions across every AI runtime you use — Claude Code, Hermes, pi, Codex, Gemini, Aider — into a single canonical store on your machine. Recall by keyword, semantic similarity, or hybrid. Browse via a local UI. Plug into agents via MCP.

This repository is a TypeScript rewrite of the original Python daemon at `../nle-memory/`. The port consolidates three runtimes (Python daemon + Node MCP shim + Astro UI) into one Node application.

---

## Architecture

`nle-memory` follows a hexagonal (ports-and-adapters) layout. The core domain has zero framework imports and is unit-tested entirely in-memory.

```
src/
├── core/                 pure domain logic — no framework imports
│   ├── recall/           keyword + semantic + hybrid scoring
│   ├── storage/          SQLite session store (sqlite-vec)
│   ├── adapters/         session source adapters (claude-code, hermes, pi, …)
│   ├── classifier/       LLM-driven session labeling
│   ├── embedding/        nomic-embed-text normalization
│   └── scheduler/        polling loop
├── ports/                interface contracts core consumes
│   ├── session-store.ts
│   ├── llm-client.ts
│   └── logger.ts
├── http/                 Hono REST + MCP HTTP transport (outer ring)
├── mcp/                  MCP server bound directly to core (no HTTP indirection)
├── ui/                   Vite + React SPA (outer ring)
├── cli/                  `nle` command entry
└── shared/               types crossed by core + outer rings
```

### Why this shape

- **Core is pure.** `core/recall` runs on fake `SessionStore` + `LLMClient` adapters in unit tests with no DB and no network. Tests live at `tests/unit/core/`.
- **Storage is swappable.** SQLite + sqlite-vec is the default zero-config backend. A Postgres + pgvector implementation can drop in by implementing the same `SessionStore` port — no changes to recall, scheduler, HTTP, MCP, or UI.
- **MCP talks to core, not HTTP.** The MCP adapter calls `RecallService.search(...)` directly. No localhost HTTP hop. The HTTP layer is a separate adapter for the UI and external integrations.
- **The framework is a detail.** Hono, Vite, commander, and better-sqlite3 are all replaceable. Core does not know about any of them.

---

## Quickstart

```bash
npm install
npm test           # unit + integration
npm run typecheck
npm run dev        # nle start with hot reload
```

The daemon reads and writes `~/.nle/canonical.sqlite` by default. Set `NLE_DB_PATH` to override.

---

## How it differs from mem0 and graphiti

- **Unit of memory:** sessions (whole conversations with markers), not facts or graph edges.
- **Audience:** the operator themselves querying their own past work, not an embedded SDK for app developers.
- **Cross-runtime:** unifies multiple AI runtimes (Claude Code, Hermes, pi, Codex, Gemini, Aider) into one corpus. This is the moat.
- **Editable timeline:** sessions can be superseded, retired, aborted. Memory is non-linear.
- **Local-only:** no hosted offering. Runs entirely on your machine.

---

## Status

Phase A scaffold complete. Core recall (keyword + semantic + hybrid) is ported and tested. Storage adapter, HTTP server, MCP server, and CLI in progress. See `logs/CHANGELOG/CHANGELOG.md` for session-by-session progress.
