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

Full scope and out-of-scope items are listed under the Threat Model below.

## Threat Model

NLM is designed for single-user, local use. Its trust boundary is the loopback interface and the local user's filesystem.

### Defenses in place

- 127.0.0.1-only bind on the HTTP API (`NLM_PORT`, default 3940)
- Host header validation on `/api/*` (defeats DNS rebinding via browser)
- Origin header validation when present (defeats cross-origin drive-by)
- Bearer token (`NLM_MCP_TOKEN`, 256-bit) for non-browser API and `/mcp` access; `timingSafeEqual` comparison
- Optional opt-in UI cookie auth (`NLM_UI_AUTH=cookie`) with HMAC-derived cookie value, rolling expiry, and a nonce-based bootstrap so the token never appears in a URL
- File permissions `0600` on `~/.nlm/.env`, `~/.nlm/canonical.sqlite`, and other state files
- Directory permissions `0700` on `~/.nlm/`, re-asserted on every daemon start

A vulnerability is anything that bypasses one of the above or exposes session data outside the local user account.

### Known limitations (not vulnerabilities)

The following are intentional design choices in the current release. Reports about them are appreciated but won't be triaged as security issues until a hardening release commits to closing them.

- **Cloud-classifier data egress.** If you opt into a cloud classifier (DeepSeek, OpenAI, Anthropic, OpenRouter, or any OpenAI-compatible endpoint), session transcripts — including anything pasted into them — are sent to that vendor. The setup wizard surfaces this; the default classifier is local Ollama.
- **Provider API keys stored in plaintext.** Keys for cloud providers live in the `providers.api_key` column of `~/.nlm/canonical.sqlite`. The file is `0600` in a `0700` directory, so the OS user is the trust boundary. OS-keychain migration is on the roadmap.
- **Untrusted indexed content reaches the classifier.** Sessions written by other AI runtimes can carry prompt-injection payloads. NLM's classifier output is structured (label/entities/decisions/open questions) and is not executed; downstream agents that act on that output must treat it as untrusted.
- **The recall hook fails open.** Any error in the Claude Code hook yields a clean exit (it must never block the model). A silently-broken hook is detectable via the daily digest's `WARN hook silent` canary.
- **Single-user assumption.** A shared-user host (e.g., multiple humans `su`ing into the same Unix account) breaks the threat model. NLM is not multi-tenant.

### What is in scope as a vulnerability

- Any path that exposes session content, provider keys, or `NLM_MCP_TOKEN` to a process running as a different OS user
- Any path that lets a cross-origin web page in a browser read or write `/api/*` or `/mcp`
- Any path that lets a malicious indexed session execute code in the daemon, mutate other sessions' content, or bypass supersedence audit logging
- Any path that exfiltrates data to a destination not in the README's outbound-traffic table

### Out of scope

- Vulnerabilities requiring local root, physical access, or shared-account abuse
- Denial of service via excessive recall queries (single-user, local-only)
- Issues in upstream dependencies that have not been patched upstream
- The five "known limitations" above (file feature requests instead)
