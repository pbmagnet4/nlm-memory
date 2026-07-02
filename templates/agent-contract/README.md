# Agent Contract Templates

These templates teach an agent the recall contract for working effectively with NLM Memory.

## Variants

- `claude-code.md` - CLAUDE.md-ready markdown section (heading + rules). Drop it into any Claude Code project's CLAUDE.md, or use `nlm init --agent claude-code --write CLAUDE.md`.
- `generic.md` - Tool-agnostic prose for any agent instruction file. Use `nlm init --agent generic --write <path>`.

## Usage

```sh
# Print to stdout
nlm init --agent claude-code
nlm init --agent generic

# Append to a file (adds begin/end markers; refuses if markers already exist)
nlm init --agent claude-code --write CLAUDE.md

# Replace the block in place when markers already exist
nlm init --agent claude-code --write CLAUDE.md --force
```

The block is delimited by `<!-- nlm-agent-contract:begin -->` and `<!-- nlm-agent-contract:end -->` so re-runs detect it and refuse to duplicate without `--force`.
