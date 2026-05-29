# Security Policy

## Supported Versions

NLM is in active development. Security fixes are only backported to the latest minor release.

| Version | Supported |
|---------|-----------|
| 0.5.x   | Yes |
| < 0.5   | No — please upgrade |

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

Out of scope:

- Vulnerabilities requiring local root or physical access
- Denial of service via excessive recall queries (the daemon is single-user, local-only)
- Issues in upstream dependencies that have not been patched upstream

## Threat Model

NLM is designed for single-user, local use. Its trust boundary is the loopback interface and the local user's filesystem. Defenses in place:

- 127.0.0.1-only bind
- Host header validation (defeats DNS rebinding)
- Origin header validation when present (defeats cross-origin drive-by)
- Bearer token (`NLM_MCP_TOKEN`) for non-browser API access
- File permissions `0600` on `~/.nlm/.env` and `~/.nlm/canonical.sqlite`
- Directory permissions `0700` on `~/.nlm/`

A vulnerability is anything that bypasses one of these or exposes session data outside the local user account.
