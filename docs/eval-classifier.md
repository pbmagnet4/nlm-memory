# Classifier Extraction-Quality Eval

Scores the **truth** of what a classifier extracts — are its decisions and
entities faithful to the transcript, and does it recover the decisions a strong
reference model found? This is the first eval in the repo that measures
extraction quality rather than structure (JSON validity, counts). Extraction
quality is upstream of every recall and precision number the daemon reports, so
it gets its own measurable score.

Harness: `scripts/eval/classifier-eval.ts` (run via `npm run eval:classifier`).
Pure scoring: `scripts/eval/extraction-scoring.ts`. Judge transport +
verdict cache: `scripts/eval/judge.ts`.

## What it measures

Per candidate classifier config, three macro-averaged surfaces:

- **Decision precision** — of the decisions a candidate extracted, what fraction
  a judge rules `supported` against the **transcript** (not the reference). A
  candidate may legitimately surface a true decision the reference missed, so
  precision is judged against ground truth, not against the reference.
- **Decision recall** — of the **reference** decisions, what fraction the judge
  rules semantically matched by some candidate decision.
- **Entity precision** — of the entities a candidate extracted, what fraction
  the judge rules actually present and relevant in the transcript.

Plus **schema-failure rate** (sessions where the candidate produced no usable
`ClassifyResult`) and **mean latency per session**.

A surface with zero items on a session yields `null`, not `0` — a session with
no extracted decisions has undefined precision, not 0%, and is dropped from the
mean rather than dragging it down.

## Gold set + references (not in the repo)

The eval reads two files from `$NLM_EVAL_DATA_DIR` (default `/tmp/nlm-309`;
see "Building the gold set" below for the recommended durable location):

- `gold-bodies.json` — `[{ id, runtime, cited, body }]`. Bodies are capped at
  20,000 chars (`GOLD_BODY_CAP` in `build-classifier-gold.ts`). Session bodies
  themselves are never committed to the repo — only aggregate scores and
  session ids reach the committed report.
- `reference.json` — `[{ id, decisions[], open[], entities[] }]`. The reference
  extraction produced by a strong model (one author per run; treat as a single
  high-quality opinion, not ground truth). Not produced by the builder script
  — see "Handoff to reference authorship" below.

Privacy contract: per-session transcripts and per-session extractions never
leave the data dir. The committed report carries aggregates + session ids only.

### Building the gold set

`scripts/eval/build-classifier-gold.ts` (`npx tsx scripts/eval/build-classifier-gold.ts`)
scripts the gold-set rebuild that used to be a manual procedure. It:

1. Copies the production DB **read-only** into a throwaway tmp dir (+ WAL/SHM)
   and reads from that copy only. It never opens `~/.nlm/canonical.sqlite` in
   place and never writes to `~/.nlm` or restarts the daemon — it is live.
   Source DB path: `--db=<path>`, or `$NLM_DB_PATH`, default
   `~/.nlm/canonical.sqlite`.
2. Selects `--n` sessions (default 30) from closed sessions with a non-empty
   body: first up to 60% of the target from ids seen in
   `~/.nlm/citation-log.jsonl` (`$NLM_CITATION_LOG` to override), then fills
   the remainder with a seeded stratified sample over
   `runtime x body-length-bucket` (buckets: short <3,000 chars, medium
   <10,000, long otherwise). Selection math is pure and fixture-tested in
   `scripts/eval/lib/gold-selection.ts` — no `Math.random` anywhere in the
   path.
3. Is fully deterministic given the same DB snapshot + `--seed` (default
   `20260722`, matching the ticket date this was built under — override with
   `--seed=<n>` for a different draw).
4. Writes both output files to `--out=<dir>`, or `$NLM_GOLD_DIR`, default
   **`~/.nlm/eval-gold/`** (durable — survives a reboot, unlike the old
   `/tmp/nlm-309` location):
   - `gold-bodies.json` — ready to use as-is.
   - `references-TODO.json` — a scaffold, see below.

```bash
npx tsx scripts/eval/build-classifier-gold.ts --n=30 --seed=20260722
```

The run prints the citation-weighted count vs. the stratified-fill count so
you can sanity-check the split before moving on.

### Handoff to reference authorship

The builder does **not** author `reference.json` — that step needs a strong
model's judgment on what decisions/entities each transcript actually contains,
which is out of scope for a deterministic selection script. Instead it emits
`references-TODO.json`, an array of:

```jsonc
{
  "id": "cc_...",          // session id — matches gold-bodies.json
  "runtime": "claude-code/1.0",
  "label": "...",           // session title, for the author's context
  "startedAt": "2026-...",
  "bodyLength": 12345,
  "decisions": [],          // to fill: decisions committed to in the transcript
  "open": [],               // to fill: open questions left unresolved
  "entities": [],           // to fill: named tools/projects/services/people
  "status": "todo"          // flip to "done" once reviewed
}
```

A human or orchestrator-run strong model reads each session's `body` from
`gold-bodies.json` by matching `id`, fills in `decisions`/`open`/`entities` for
every entry, and flips `status` to `"done"`. Once every entry is done, strip
the authoring-context fields (`runtime`, `label`, `startedAt`, `bodyLength`,
`status`) and save the result as `reference.json` in the same directory — that
trimmed shape (`{ id, decisions[], open[], entities[] }`) is exactly what
`classifier-eval.ts` reads. A one-liner does the strip:

```bash
jq '[.[] | {id, decisions, open, entities}]' references-TODO.json > reference.json
```

## Running

Before running this full LLM-judge eval, verify that your classifier lane
produces well-formed output by running the deterministic fixture eval first:

```sh
nlm eval --classifier
```

This takes minutes, requires no additional data files, and will surface schema
failures or calibration problems early. See `docs/classifier-tiers.md` for
metric definitions and tier baselines. Once the fixture eval passes and the
gold set + reference.json exist under `~/.nlm/eval-gold/` (see above), proceed
with the judge-based eval below.

```bash
NLM_EVAL_DATA_DIR=~/.nlm/eval-gold \
NLM_OLLAMA_URL=http://localhost:11434 \
NLM_EVAL_JUDGE_MODEL=Qwen3.5-122B-A10B-mlx-nvfp4 \
npm run eval:classifier
```

Output: `$NLM_EVAL_DATA_DIR/eval-results.json` (working artifact, not
committed) plus a markdown table printed to stdout. Copy the table + caveats
into a dated report under `reports/classifier-eval/`.

### Env vars

`classifier-eval.ts`:

| Var | Default | Purpose |
| --- | --- | --- |
| `NLM_EVAL_DATA_DIR` | `/tmp/nlm-309` | Gold set + references + per-run cache. Point this at `~/.nlm/eval-gold` (the builder's default output dir) once you've run `build-classifier-gold.ts`. |
| `NLM_EVAL_CACHE_DIR` | `$DATA_DIR/cache` | Classifier + judge SQLite caches |
| `NLM_OLLAMA_URL` | `http://localhost:11434` | Prod-candidate Ollama endpoint |
| `NLM_CLASSIFIER_MODEL` | `qwen3:4b-instruct-2507-q4_K_M` | Prod-candidate model (matches the live daemon default) |
| `NLM_EVAL_JUDGE_MODEL` | `Qwen3.5-122B-A10B-5bit` | Judge model on the Studio |
| `NLM_EVAL_CANDIDATES` | unset (hardcoded 3-candidate list) | JSON array of `{name, provider, baseUrl?, model}` — see "Adding a candidate" below. When set, **replaces** the hardcoded list entirely. |

`build-classifier-gold.ts`:

| Var / flag | Default | Purpose |
| --- | --- | --- |
| `--n` | `30` | Target gold-set size |
| `--seed` | `20260722` | Seed for the deterministic PRNG (citation weighting + stratified fill) |
| `--db` / `NLM_DB_PATH` | `~/.nlm/canonical.sqlite` | Source DB to sandbox-copy from (never opened live) |
| `--out` / `NLM_GOLD_DIR` | `~/.nlm/eval-gold` | Output dir for `gold-bodies.json` + `references-TODO.json` |
| `NLM_CITATION_LOG` | `~/.nlm/citation-log.jsonl` | Citation log used for the weighting signal |

### Caching

Both the classifier and the judge cache to disk keyed by content hash
(`scripts/longmemeval/classifier-cache.ts` and `JudgeCache` in `judge.ts`).
Re-runs are cheap: only new (model, body) pairs and new judge prompts execute.
The judge parses a reply **before** caching it, so a malformed verdict is never
persisted — a re-run retries it cleanly.

## Adding a candidate

Two ways, depending on whether the change should stick around:

**Ad hoc / one-off runs — `NLM_EVAL_CANDIDATES` env var.** Set it to a JSON
array of `{name, provider, baseUrl?, model}` and it **replaces** the hardcoded
list for that run (the hardcoded list is still the default when the var is
unset):

```bash
NLM_EVAL_CANDIDATES='[
  {"name": "prod ollama qwen3:4b", "provider": "ollama", "model": "qwen3:4b-instruct-2507-q4_K_M"},
  {"name": "audition Foo-9B", "provider": "openai-compatible", "baseUrl": "http://localhost:8000/v1", "model": "Foo-9B-MLX-8bit"}
]' npm run eval:classifier
```

- `provider: "ollama"` reuses the production `OllamaClient` (`baseUrl`
  defaults to `$NLM_OLLAMA_URL`).
- `provider: "openai-compatible"` reuses the harness-local
  `OpenAICompatibleClassifier` (Studio auditions and any other OpenAI-shaped
  endpoint; `baseUrl` defaults to `$NLM_EVAL_BASE_URL`).
- Each spec's cache key is `"<provider>:<model>"` — the cache namespaces on
  it, so two specs with the same provider+model share a cache. A malformed
  spec (bad JSON, missing field, unknown provider) throws immediately rather
  than silently skipping a candidate.

**Permanent additions — edit `buildCandidates()` in `classifier-eval.ts`.**
Each candidate is `{ key, label, client }` where `client` implements
`ClassifierClient` (`classify(transcript): Promise<ClassifyResult>`). Use the
same `OllamaClient` / `OpenAICompatibleClassifier` building blocks as above (or
`DeepSeekClient` from `src/llm/` for a DeepSeek lane, which the env-var path
does not yet support). Keep `key` distinct per model — same cache-namespacing
rule as above.

## Sequencing on the Mac Studio (oMLX)

The Studio serves **one big model at a time** and does not auto-evict. The
harness runs **all candidate-A classifications, then all candidate-B, then all
judge calls** so each model loads once instead of thrashing. Two hard-won
constraints:

- **Judge must stream.** oMLX returns an empty 200 on a non-streaming
  mid-generation error and surfaces errors *inside* the SSE stream. `judge.ts`
  always requests `stream: true` and treats an empty assembled body as failure.
- **Judge memory ceiling.** The judge embeds the transcript once per
  decision/entity precision check. The full 20K body overflowed the
  `122B-A10B-5bit` prefill memory cap; the harness caps the judge-embedded
  transcript at 12K (head + tail) and the run uses the lower-footprint
  `122B-A10B-mlx-nvfp4` quant of the same model. If the 5bit quant is resident
  alongside a prior audition model, it will fail to load with a
  `Prefill context too large` error at `kv_len=0` — prefer the nvfp4 quant or
  ensure the prior model is evicted first.

## Limitations

- Single reference author per run — the reference is one strong opinion, not
  consensus ground truth.
- Single judge model — judge bias is not cross-checked.
- N is small (~30) — treat surface deltas under a few points as noise.
- Judge abstentions (verdicts unparseable after retry) degrade to a
  conservative verdict and are reported in `judge_abstentions`; a high count
  undermines the run.
