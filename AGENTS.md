# NLM agent guide

Read [CONTRIBUTING.md](CONTRIBUTING.md) for development checks, [release status](docs/release-status.md) for stable/prerelease availability, and [memory properties](docs/properties.md) before changing attribution.

- Keep session relevance separate from fact ownership. Automatic property inference remains disabled pending a separately evaluated activation.
- Use the release workflow's explicit channel selection: prereleases go to npm `next` and GitHub prerelease/non-latest; stable releases use `latest`.
- A local branch can contain private operational history. Start public distribution branches and release tags from reviewed public ancestry, normally `origin/main`; inspect both the content and ancestry before pushing.
- Never publish private transcripts, databases, credentials, deployment plans or operational changelogs. A clean worktree or passing secret scan alone does not establish that history is safe to publish.
