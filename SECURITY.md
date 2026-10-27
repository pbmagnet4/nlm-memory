# Security Policy

## Supported versions

Report vulnerabilities against the latest published stable release. Source candidates and experimental features are not stable releases. The [release-status page](docs/release-status.md) distinguishes the channels; unsupported older versions should be upgraded.

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Email security reports to **echalupa@whtnxt.io** with:

- A description of the vulnerability
- Steps to reproduce, ideally with a minimal proof of concept
- The version of NLM affected (`nlm --version`)
- Your platform (macOS / Linux / Windows) and Node version

You should receive an acknowledgement within 72 hours. If the report is confirmed, expect a fix in the next patch release; severe issues will be patched out-of-band.

## Scope

In scope:

- The daemon (`nlm start`, HTTP API at `localhost:3940`)
- The MCP server (stdio and `/mcp` HTTP endpoints)
- The Claude Code / Codex / Hermes hooks
- The setup wizard and CLI commands
- The on-disk format of `~/.nlm/canonical.sqlite` and `~/.nlm/.env`

Full scope and out-of-scope items are listed under the Threat Model below.

## Threat model and data flow

Local use trusts the operating-system user who owns NLM's state. The default daemon binds to loopback. A process running as the same user can read that user's files and memory database. Do not treat project/property filters, workstreams or directory scopes as access-control boundaries.

### Access controls

- Host and Origin checks protect local `/api/*` requests against browser-origin attacks.
- `/mcp` requires a bearer token and resolves its tenant from that token.
- Local API mode without UI authentication permits local requests after Host/Origin checks. Setting `NLM_UI_AUTH=cookie` adds cookie or bearer authentication. Hosted mode requires a resolvable bearer token. Local mode should not be exposed directly to the internet.
- Tenant-scoped storage queries and recall filters implement team isolation. Stdio MCP is local and bound to the default team; use the HTTP transport for token-resolved team access.
- State-file permissions are hardened to the local user. Provider credentials currently live in the SQLite provider registry in plaintext; protect the database and every backup as you would a credential file.

### Data leaving the machine

| Configuration or action | Data/destination |
|---|---|
| Local Ollama classifier/embeddings | Content goes to the configured local endpoint. |
| Remote classification, query rewriting or fact judging | Relevant transcript, query or fact content goes to the selected endpoint. Anything pasted into a session may be included. |
| Remote prose/code embeddings | Relevant text/code goes to the configured embedding provider. |
| Update checks | Requests to the npm registry; disable with `NLM_DISABLE_UPDATE_CHECK=1`. |
| Opt-in Telegram digest or alert webhook | Digest or event payloads go to the configured notification destination. |
| Manually invoked evaluation tools | Model-backed evaluation can send the supplied examples to its configured judge/generator. Inspect the tool and configuration before running it on private data. |

There is no analytics SDK or required NLM account for local use. Local-first does not mean that a remote model configuration keeps content on the machine. Transcript filesystem reads themselves are local I/O, not outbound network traffic.

### Untrusted memory and operational limits

Indexed sessions and retrieved passages can contain malicious instructions. Treat them as untrusted source material, not privileged agent instructions. Structured classifier output is not executed by NLM, but downstream agents must not automatically trust it.

Hooks fail open to avoid blocking the calling runtime. Use health checks and the digest's hook-liveness reporting to detect silent failure. Hostile local-user processes, root access, shared-account abuse and upstream dependency behavior are outside NLM's local-user isolation guarantee. Report a reproducible boundary bypass privately rather than assuming a known limitation makes every related report out of scope.

Backups contain memories and can contain provider credentials. Do not attach them to public issues. See [release status](docs/release-status.md) before upgrading or downgrading a database writer.
