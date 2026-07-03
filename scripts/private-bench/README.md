# Private-corpus bench harness

Evaluates NLM recall against a locked, operator-managed query set drawn from
real sessions. The query file and report outputs live **outside this repo** to
keep client names and question text out of committed artifacts.

## Locked-file contract

Set `NLM_PRIVATE_BENCH_QUERIES` to the absolute path of the query JSON file
before running. The file must satisfy this schema:

```json
{
  "locked": true,
  "lockedAt": "YYYY-MM-DD",
  "queries": [
    {
      "id": "q-001",
      "category": "factual",
      "question": "What did we decide about the pricing model?",
      "goldSessionIds": ["session-abc123", "session-def456"]
    }
  ]
}
```

The harness refuses (exit 1) when:

- `NLM_PRIVATE_BENCH_QUERIES` is not set
- The file does not exist
- `locked` is not exactly `true` (boolean)
- `queries` is missing or empty

Set `locked: true` only after the query set is finalized. Running against a
partial or draft query set produces meaningless scores that cannot be compared
across runs.

## Creating the DB snapshot

The harness queries an existing corpus. Pass a VACUUM INTO snapshot rather
than the live DB so writes from other processes do not affect the run:

```bash
sqlite3 ~/.nlm/canonical.sqlite "VACUUM INTO '/path/outside/repo/snapshot.sqlite'"
```

Then pass `--db /path/outside/repo/snapshot.sqlite`.

## Usage

```bash
NLM_PRIVATE_BENCH_QUERIES=/path/outside/repo/queries.json \
node dist/scripts/private-bench/run-harness.js \
  --db /path/outside/repo/snapshot.sqlite \
  --modes keyword,semantic,hybrid \
  --limit 100 \
  --k 5 \
  --report-dir /path/outside/repo/reports/private-bench
```

### Dry-run

Validates the lock file and prints the query plan without touching the DB:

```bash
NLM_PRIVATE_BENCH_QUERIES=/path/outside/repo/queries.json \
node dist/scripts/private-bench/run-harness.js \
  --dry-run --modes keyword --limit 10 --report-dir /tmp/unused
```

### Flags

| Flag | Default | Description |
|---|---|---|
| `--db` | required (non-dry-run) | Path to the VACUUM INTO SQLite snapshot |
| `--modes` | `keyword,semantic,hybrid` | Comma-separated recall modes |
| `--limit` | 0 (all) | Maximum queries to run |
| `--k` | 5 | Recall depth (R@k) |
| `--report-dir` | required | Directory for output files |
| `--dry-run` | false | Validate and print plan only |

## Outputs

Written to `--report-dir` after a real run:

| File | Contents |
|---|---|
| `summary.md` | Aggregate R@1 / R@3 / R@k per mode, per-category breakdown |
| `results.json` | Aggregate + per-category + per-query (id, category, scores) |

**Question text is never written to any output file.** Per-query entries
contain only `id`, `category`, and mode scores. Keep `--report-dir` outside
the repo to avoid committing client content.

## Scoring

Primary metric: **R@k** (recall at k) scored against `goldSessionIds`. A
query scores 1 if any gold session ID appears in the top-k returned results.
Session-body-hit is not computed (no gold answer text in the query format).
