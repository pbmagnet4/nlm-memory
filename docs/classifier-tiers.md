# Classifier tier expectations

> The classifier is the moat for keyword recall. This doc explains the three
> operating points, how to measure the one you have configured, and how to
> upgrade between tiers.

## The three operating points

All three tiers share one frozen prompt contract (`src/core/classifier/prompt.ts`).
The prompt is not swapped between measurements. Changing it invalidates
comparability across runs and across the baselines table below.

| Tier | Provider | Example model | Notes |
|---|---|---|---|
| Floor | `ollama` (local) | `qwen3.5:4b` | Default install; runs on the same machine as the daemon; no API key required |
| Mid | `openai` (any OpenAI-compatible endpoint) | `qwen3:32b` served via LM Studio or vLLM | Off-box or co-located; set `NLM_CLASSIFIER_BASE_URL` to point at the endpoint |
| Cloud | `deepseek` or `openai` | `deepseek-v4-flash` | Requires `NLM_CLASSIFIER_API_KEY`; fastest classification; egress notice shown at daemon start |

**Lane env vars:**

| Var | Purpose |
|---|---|
| `NLM_CLASSIFIER` | Provider: `ollama` (default), `deepseek`, or `openai` |
| `NLM_CLASSIFIER_MODEL` | Model id to pass to the provider. Required when `NLM_CLASSIFIER=openai`. |
| `NLM_CLASSIFIER_BASE_URL` | Endpoint override for the `openai` provider (e.g. `http://localhost:1234/v1` for LM Studio). |
| `NLM_CLASSIFIER_API_KEY` | API key for cloud providers or secured local endpoints. |

## How to measure your configured lane

### Quick check: shipped gold fixtures (minutes)

```sh
nlm eval --classifier
```

Runs the 20 hand-authored synthetic transcripts in `fixtures/classifier-gold/`
against your configured lane and prints a scored report:

```
lane: ollama/qwen3.5:4b
n=20
schema-valid:     X%
label-accuracy:   X%
entity-F1:        X%
decision-F1:      X%
conf-calibration: X%
p50-latency:      Xms
p95-latency:      Xms
see: docs/classifier-tiers.md
```

Flags:
- `--limit N` -- run only the first N fixtures (default: all 20)
- `--json` -- emit the full JSON result including per-transcript rows

The fixtures cover: bug fixes, features, refactors, ops/infra sessions,
research/writing, meeting notes, and low-signal/trivial sessions. Low-signal
fixtures (IDs 17-20) assert confidence calibration in both directions: trivial
sessions must score `<= 0.4`; substantive sessions must score `> 0.4`.

### Full pipeline measurement: LongMemEval-S (hours first pass, seconds after)

```sh
# Configured lane (reads NLM_CLASSIFIER / NLM_CLASSIFIER_MODEL /
# NLM_CLASSIFIER_BASE_URL / NLM_CLASSIFIER_API_KEY)
npm run bench:classifier -- configured

# Specific model without changing your live config
npm run bench:classifier -- ollama:qwen3.5:4b
npm run bench:classifier -- deepseek:deepseek-v4-flash
```

This pre-classifies every haystack session in LongMemEval-S, inserts the
extracted label, entities, and decisions, then scores retrieval R@5 against
the published questions. It is the only measurement that attributes the
contribution of classifier choice to the headline recall number.

Classification results cache at `~/.cache/longmemeval/classifier.sqlite` keyed
by `sha256(provider + model + body)`. The first pass takes hours (one LLM call
per unique body). Re-runs against the same model are seconds.

See `docs/methodology-recall-baseline.md` for the full harness options,
comparison tooling, and the LongMemEval-S dataset setup.

## Baselines

> All rows measured 2026-07-02 with `nlm eval --classifier --json` (n=20 shipped fixtures). Fill or refresh by running
> `nlm eval --classifier --json` with each tier configured. See the upgrade
> path below for how to switch lanes before measuring.

| Tier | Example model | Schema validity | Label accuracy | Entity F1 | Decision F1 | Calibration | p50 latency |
|---|---|---|---|---|---|---|---|
| Floor | `qwen3.5-4b` (local, OpenAI-compatible endpoint) | 100% | 80% | 48% | 44% | 85% | 24.0s |
| Mid | `qwen3.6-35b-a3b` (MoE, OpenAI-compatible endpoint) | 100% | 80% | 54% | 57% | 95% | 42.2s |
| Cloud | `deepseek-v4-flash` | 100% | 95% | 66% | 55% | 95% | 9.0s |

Columns are the aggregate fields from `nlm eval --classifier --json`:
`schemaValidRate`, `labelAccuracy`, `entityF1`, `decisionF1`,
`confidenceCalibrationRate`, and `p50LatencyMs`.

## Upgrade path

Swapping to a stronger classifier improves: label quality, entity extraction,
and decision extraction. It does not change: workstream bindings (preserved by
`nlm reprocess`), prior citations (still reference the same session IDs), or
retrieval code (FTS5 BM25 and the metadata tiebreaker are not model-dependent).

### Steps

**1. Measure the current lane.**

```sh
nlm eval --classifier
```

Keep the output. It is your before state.

**2. Swap the lane env vars.**

Edit `~/.nlm/.env` (or your shell env) to point at the target tier:

```sh
# Example: floor to cloud
NLM_CLASSIFIER=deepseek
NLM_CLASSIFIER_MODEL=deepseek-v4-flash
NLM_CLASSIFIER_API_KEY=<your key>

# Example: floor to mid (local LM Studio at port 1234)
NLM_CLASSIFIER=openai
NLM_CLASSIFIER_MODEL=qwen3:32b
NLM_CLASSIFIER_BASE_URL=http://localhost:1234/v1
```

Restart the daemon (`nlm start`) to pick up the new lane.

**3. Confirm the new lane on gold fixtures.**

```sh
nlm eval --classifier
```

Compare against step 1. Higher entity-F1 and decision-F1 translate directly to
better keyword recall on your corpus.

**4. Dry-run the reprocess to see the cohort.**

```sh
nlm reprocess --dry-run
```

Prints a cohort report: how many sessions have NULL provenance (pre-tracking),
how many were classified by a different model, and the confidence distribution
across both groups. No writes happen.

**5. Run the reprocess.**

```sh
# All eligible sessions
nlm reprocess

# Bounded run (safe to interrupt and resume)
nlm reprocess --limit 500

# Also re-classify same-model sessions below a confidence threshold
nlm reprocess --min-confidence 0.6
```

Reprocess selects sessions ordered by `started_at DESC`, so recent sessions
get upgraded first when `--limit` is set. The operation is resumable: a state
file at `~/.nlm/reprocess.state` tracks completed sessions. A lane change
(different provider or model) resets the done-set automatically.

**6. Measure again.**

```sh
nlm eval --classifier
```

The fixture score measures classifier quality in isolation, not end-to-end
recall on your corpus. To measure end-to-end improvement, follow the
query-curation approach in `docs/methodology-recall-baseline.md` or run
`npm run bench:classifier -- configured` against LongMemEval-S.

### What reprocess changes and what it does not

| What | Changed? |
|---|---|
| Session label, summary, entities, decisions, open questions | Yes |
| Session body (raw transcript text) | No |
| Classifier provenance (`classifier_provider`, `classifier_model`, `classifier_confidence`) | Yes |
| Session embedding chunks | Yes |
| Facts (sessions scoring above the 0.4 confidence floor) | Yes |
| Facts (sessions scoring below the 0.4 confidence floor) | No -- prior facts preserved |
| Workstream binding (`workstream_id`) | No -- never changed by reprocess |
| Prior citations | No -- citation log references session IDs, which do not change |
| Backend | SQLite only -- Postgres reprocess is not yet implemented |

## Limitations

**NULL provenance on pre-tracking corpora.** Sessions ingested before Phase 2
have `classifier_provider = NULL` and `classifier_model = NULL`. This is their
selection criterion for `nlm reprocess`: NULL means "never tracked, eligible
regardless of current model." A fresh `nlm reprocess --dry-run` on an existing
corpus will show nearly all sessions in the NULL cohort.

**One classify call per session.** Reprocess calls the classifier once per
eligible session. On a large corpus with a slow local model this takes time. Use
`--limit` and the resume state file to spread the work across multiple runs.

**The 97.2% R@5 figure is corpus-specific.** The README headline was measured on
a 14-month personal corpus with `deepseek-v4-flash` as the classifier. Your
corpus and your classifier tier will produce a different number. See
`docs/methodology-recall-baseline.md` for the methodology behind that figure
and how to derive an equivalent number on your own data.

**Ollama model detection requires `NLM_CLASSIFIER_MODEL`.** When
`NLM_CLASSIFIER=ollama`, a model swap is only detected by the resume-state
invalidation logic when `NLM_CLASSIFIER_MODEL` is set explicitly. If you rely on the Ollama default
without setting this var and swap the model Ollama loads, the state file will
not detect the change and may skip sessions that should be reprocessed. Set
`NLM_CLASSIFIER_MODEL` explicitly to avoid this.
