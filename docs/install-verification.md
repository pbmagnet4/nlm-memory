# Install verification (`nlm verify`)

`nlm verify` is the release gate. Run it before `npm publish` and after any
fresh install to confirm the daemon is wired and recall works end-to-end. It
exits non-zero on any failure so it can gate CI.

## What it checks

Each line is `PASS` / `WARN` / `FAIL`, and every non-pass prints the exact fix.

| Check | Meaning | Fail → fix |
|-------|---------|-----------|
| `daemon` | daemon reachable on `NLM_PORT` (default 3940) | `nlm start` |
| `daemon-version` | running daemon matches the installed binary | `nlm restart` |
| `mcp-token` | `NLM_MCP_TOKEN` resolves (value never printed) | `nlm setup` |
| `claude-code` | nlm MCP block present in `~/.mcp.json` | `nlm connect claude-code` |
| `codex-stale` | no pre-rename `nlm-memory-ts` entry in Codex config | `nlm connect codex --repair` |
| `codex` | Codex config (if present) is wired | `nlm connect codex` |
| `models` | embedding + classifier models present (Ollama backend) | `nlm setup` |
| `db-integrity` | all DB invariants (I1–I6) hold; `I5a-mv` reports multi-valued predicate exemptions informationally and does not fail the gate | `nlm doctor --fix` |
| `recall-smoke` | `GET /api/recall` returns a well-formed result set | `nlm restart; check nlm logs` |

`WARN` (e.g. an optional runtime not wired) does not fail the gate; `FAIL` does.

`nlm verify` shares its check logic with `nlm doctor` — doctor diagnoses an
existing install (DB invariants + install health); verify adds the model and
end-to-end recall smoke checks and a single overall verdict for CI.

## Fresh-install matrix

Run `nlm verify` under each scenario below after `npm pack` → `npm i -g <tarball>`
→ `nlm setup`. The expected column is the overall verdict; individual WARNs are
acceptable where noted.

| Scenario | Expected | Notes |
|----------|----------|-------|
| Clean macOS user | PASS | baseline |
| Clean Linux user | PASS | baseline |
| Claude Code only | PASS | `codex` WARN expected (no Codex config) |
| Codex only | PASS | `claude-code` WARN expected |
| Both runtimes | PASS | no WARNs |
| No Ollama installed | FAIL | `models` + `recall-smoke` fail until `nlm setup` |
| Ollama up, model missing | FAIL | `models` names the missing tag |
| Daemon already running | PASS | idempotent |
| Stale `~/.nlm` from prior version | PASS | `daemon-version` WARN until `nlm restart` |
| Stale Codex `nlm-memory-ts` plugin | FAIL | `codex-stale` → `nlm connect codex --repair` |

## Reproduce

```
npm pack
npm install -g ./nlm-memory-*.tgz
nlm setup
nlm verify        # exit 0 = ship-ready; exit 1 = miswired (see fixes above)
```
