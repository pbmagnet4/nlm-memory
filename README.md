<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/banner-dark.svg" />
    <source media="(prefers-color-scheme: light)" srcset="assets/banner-light.svg" />
    <img alt="NLM — local-first memory for AI agents" src="assets/banner-light.svg" width="720" />
  </picture>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/nlm-memory"><img src="https://img.shields.io/npm/v/nlm-memory?label=stable%20npm" alt="Stable npm version" /></a>
  <a href="https://github.com/pbmagnet4/nlm-memory/actions/workflows/ci.yml"><img src="https://github.com/pbmagnet4/nlm-memory/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/pbmagnet4/nlm-memory" alt="Apache 2.0" /></a>
</p>

# Memory for agents that work across tools and projects

NLM indexes AI sessions into a local searchable store. Recover an earlier decision, inspect the source conversation, and mark outdated reasoning as superseded. An agent using one runtime can retrieve work captured from another.

**Local-first. Source-backed. Correctable.** SQLite is the default; PostgreSQL with pgvector is also supported. No NLM account is required for local use. Classification and embedding providers are configurable: choosing a remote provider sends relevant content to it. See [data flow and security](SECURITY.md).

[Install](#install) · [Demo](#try-a-safe-demo) · [Runtimes](docs/runtimes.md) · [API](docs/api.md) · [Evidence](docs/evaluations.md) · [Roadmap](ROADMAP.md)

## Release status

| Channel | What you can use |
|---|---|
| **Stable npm: 0.21.20** | Cross-runtime session capture, bounded session/context recall, source expansion and an editable timeline. [Release notes](https://github.com/pbmagnet4/nlm-memory/releases/tag/v0.21.20). |
| **Public prerelease: 0.21.21-rc.1** | Canonical property catalogs, explicit fact/session associations, repository-origin session references and property-filtered recall. Install explicitly with `npm install -g nlm-memory@next`. Stable npm does not contain these features. [Prerelease notes](https://github.com/pbmagnet4/nlm-memory/releases/tag/v0.21.21-rc.1). |
| **Experimental, disabled by default** | Automatic fact ownership and entity-name session associations. Evaluation found wrong-project matches; neither a subject label nor a project name inside a quote reliably proves ownership. |

[Full status and upgrade notes](docs/release-status.md). Source availability is not a promise that an experimental feature has passed its evaluation gate.

## Install

Node.js **22 or newer** and an embedding/classification provider are required. The setup wizard helps configure providers and the runtimes you use.

```sh
npm install -g nlm-memory
nlm setup
nlm recall "why did we change the database?"
```

Open `http://localhost:3940/ui` to browse the timeline and search. macOS and Linux support managed daemon setup; Windows currently uses manual `nlm start`.

If you use local Ollama, make the configured classifier and embedding models available before indexing. A cloud classifier is optional, and receives session content. [Configuration](docs/configuration.md) · [Security](SECURITY.md).

## What an agent can do

| Need | Tool or behavior |
|---|---|
| “What did we decide last time?” | `recall_sessions` returns compact session summaries and continuation pointers. |
| “Show me the evidence.” | `get_session` retrieves matching passages or bounded original transcript pages. |
| “What is the current value, and is there disagreement?” | `recall_context`, `recall_facts` and `get_fact_history` expose structured facts, provenance and history. Inspect partial-coverage indicators. |
| “That earlier decision is obsolete.” | `mark_superseded` records the replacement relationship; history remains inspectable. |
| “Only show memories associated with this project.” | The prerelease accepts canonical `property` filters. Explicit assignments and repository relevance are separate from inferred fact ownership. |

MCP over the local daemon's `/mcp` endpoint is the default connection. Automatic hooks depend on the runtime; capture support does not imply hook support. Per-prompt ambient recall is off by default on fresh installs. [Runtime matrix and hooks](docs/runtimes.md) · [MCP/HTTP reference](docs/api.md).

## Try a safe demo

The [project-memory demo](docs/demo.md) runs on a disposable SQLite database using fictional Atlas and Beacon sessions. It demonstrates cross-runtime evidence, a superseded decision, a property filter, and an explicit ownership correction.

```sh
git clone https://github.com/pbmagnet4/nlm-memory.git
cd nlm-memory
npm ci
npm run demo:memory
```

No classifier, embedding provider, daemon or real transcript is used. The demo calls the storage APIs directly; it is a behavior walkthrough, not an end-to-end capture or answer-quality benchmark.

## What has been measured?

| Evidence | What it establishes | Limits |
|---|---|---|
| Historical LongMemEval-S run: 97.2% R@5, 500 queries | Retrieval of annotated source sessions on that benchmark/configuration. | Not generated-answer accuracy or a guarantee for another model/corpus. |
| Historical personal-corpus baseline: 36/40 queries retrieved within five hits | Recovery on a small curated query set. | Private corpus; small and selected sample. |
| Property attribution evaluation | Subject-only and quote-name matching produced wrong-owner assignments. | Automatic ownership remains gated; coverage is not precision. |
| SQLite/PostgreSQL contracts and CI | Regression checks for source integrity, property isolation and transport behavior. | Passing tests do not establish retrieval usefulness. |

Methods, dates, configuration and limitations: [evaluation guide](docs/evaluations.md). Older measurements describe their recorded versions, not an assumed score for current main.

## Documentation

- [Runtime integrations and hooks](docs/runtimes.md)
- [MCP tools and HTTP API](docs/api.md)
- [Context retrieval and response budgets](docs/context-retrieval.md)
- [Editable timeline](docs/supersedence.md)
- [Canonical memory properties](docs/properties.md) — prerelease
- [Configuration](docs/configuration.md)
- [Signals and optional code exemplars](docs/signals.md)
- [Digest and UI](docs/operations.md)
- [Security and vulnerability reporting](SECURITY.md)
- [Roadmap and contribution priorities](ROADMAP.md)

## Development

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run verify:codex-release -- --check-packed
```

`dist/` is generated and not tracked. The packed package contains the distributable and plugin assets. PostgreSQL contracts are opt-in locally through `NLM_PG_TEST_URL`; GitHub CI provides pgvector and runs that suite.

Keep examples synthetic and never include a real memory database, provider credentials or private transcripts in an issue or pull request. [Contribution guide](CONTRIBUTING.md).

Apache 2.0 — [LICENSE](LICENSE).
