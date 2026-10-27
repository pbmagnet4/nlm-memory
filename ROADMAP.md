# Roadmap

Priorities are scoped outcomes, not release dates. Published capability status is in [release status](docs/release-status.md).

| Priority | Outcome | Acceptance criteria |
|---|---|---|
| Property ownership accuracy | Distinguish the owner of an assertion from dependencies, runtime paths and quoted examples. | New source-disjoint labels, frozen gates and negative cases; preserve abstention. Automatic inference stays off until its evaluation passes. |
| Recall usefulness | Make retrieved context useful for the current question without flooding the agent. | Independently judged useful/irrelevant/harmful outcomes, exact response-budget measurements, and comparison with pull-first retrieval. Do not treat citation rate as answer quality. |
| Repository-origin recovery | Recover historical worktree origin when verifiable evidence survives. | Test extant, deleted, nested, ambiguous and cross-host cases; abstain when identity cannot be established. Never guess from a branch/directory name alone. |

[Open product issues](https://github.com/pbmagnet4/nlm-memory/issues) carry concrete work and discussion. [Contributing](CONTRIBUTING.md) explains how to submit a synthetic reproduction.
