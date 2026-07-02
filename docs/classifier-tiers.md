# Classifier Tier Baselines

Scores from `nlm eval --classifier` against the 20-fixture gold set shipped in
`fixtures/classifier-gold/`. Run with `--json` for machine-readable output.

| Lane | Schema valid | Label acc | Entity F1 | Decision F1 | Conf cal | p50 ms | p95 ms |
|------|-------------|-----------|-----------|-------------|----------|--------|--------|
| _pending first run_ | | | | | | | |

## Adding a baseline

Run `nlm eval --classifier --json` against your configured lane and paste the
`aggregate` block into the table above, adding a `provider/model` label column.
Keep entries in chronological order; older runs document regression history.

## Gold set

20 synthetic transcripts spanning bug-fix, feature, refactor, ops, research,
writing, meeting, and trivial categories. Labels, entities, decisions, and a
`expectLowConfidence` flag per fixture live in `fixtures/classifier-gold/reference.json`.

See `docs/eval-classifier.md` for the full-corpus (production DB) eval harness
that complements these shipped fixtures.
