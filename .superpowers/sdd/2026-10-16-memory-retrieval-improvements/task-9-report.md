# Task 9 report — decision-model reranking capability preflight

**Status:** documentation-only preflight complete for independent review;
scientific qualification **INCONCLUSIVE / NO-GO**. No candidate is registered
for Task 10. Source baseline: `74afcfad32e56dc3aa4562e6f60a15cc405b6713` on
`feat/T806-memory-retrieval`. The preflight stopped before adding a reranker,
port extension, prompt/trigger, evaluator state, model setting or model call.
Root owns the plan/spec/progress ledger, task synchronization and final landing.

## Scope and governing decision

Read the Task 9 brief, constraints, spec experiments/measurement contracts and
applicable git/token standards before writes. Applied critical-review to the
load-bearing accounting, bounded-call and reader claims against actual code.
The brief's proposed file list is conditional: spec section 4 explicitly allows
no-go when the existing client cannot supply qualified accounting/cap capability.
The exact-token and blinded-reader gaps independently prevent the required
quality/cost gates. Building an unused framework would not resolve them.

Owned durable deliverable: `docs/memory-decision-model-experiment.md`, plus this
report. No other files were edited; other actors' files were preserved. No
subagents/reviewers were launched. Root performs the independent scoped review.

## Configured lane and primary evidence

Observation window: 2026-10-17 approximately 04:27–04:30 UTC (2026-10-16 Chicago).
Configuration inspection reported only allowlisted classifier provider/model/base/
maxTokens and nonsecret gate settings from `~/.nlm/.env`. The authentication key
was handled in memory for metadata GETs. No credentials, complete environment,
source bodies or complete gateway responses were printed or saved.
There were no provider/model process overrides in the inspection process.

- Provider `openai`; model/role `litellm-classifier`; base
  `http://192.168.2.2:4000`; max-token override absent; ingest gate `off`.
  `buildClassifier` autoloads env, then `ClassifierBox.construct` selects
  DeepSeekClient with this base/model, response-format none and a default
  classify/output budget of 8192. Factory comments naming older production
  models were not treated as current configuration.
- Initial metadata GETs were sandbox-network denied. Narrow escalated read-only
  retries succeeded; no generation endpoint was requested. `GET /model/info`
  returned 81 deployments; the two selected `litellm-classifier` entries both
  report `openai/gemma-4-12B-it-qat-oQ4e-mtp`, IDs
  `a9f6b050-844c-4d25-be8c-869e8cd60a52` and
  `e8f7e73a-1799-4a22-9ecf-46ab4c92af97`. `max_output_tokens` metadata is null.
  `GET /v1/models` returned 80 aliases and advertised `litellm-classifier`.
  No decision-named chat role was returned by either filtered list. This is
  role resolution metadata, not immutable weights/revision/cap proof.
- `GET /config/pass_through_endpoint` confirms authenticated
  `/clef/v1/systemone` forwarding to the existing Pro/Studio bridge. It is a
  separate structured endpoint. `askClef` returns answers/ms and exposes neither
  usage nor an output-token cap; it uses its own timeout without caller abort
  composition. No Clef inference was issued and no direct provider was added.
- `LLMClient.complete`/ClassifierBox return text only; DeepSeek ChatResponse
  declares choices only and discards response model/usage. HTTP/network failures
  become errors without gateway accounting reconciliation. `ClassifyResult`
  also carries no usage: extraction accounting is unavailable, not zero, and
  extraction must never be duplicated in a future recall hot path.
- Complete sends max_tokens; this proves request shaping, not provider cap
  enforcement. The selected adapter installs an anonymous caller abort listener
  but clears only its internal timer in finally; complete lacks the classify
  method's already-aborted check. Existing Ollama complete also lacks measured
  usage and ignores maxTokens; it is unsupported and was left untouched.
- Evaluation CLI lines 218/225 reject a non-null tokenizer and pass null. Its
  literal reader lines 12–29 emits usage null. The run/accounting seam preserves
  unavailable totals. Cached embedding proxy lines 64–75 supports only embed;
  non-embedding methods throw and remain failed attempt events with null usage.
  Installed @huggingface/transformers 4.2.0 is not an actual consumer tokenizer.
  Hook prompt-recall `estTokens` is ceil(chars/4), excluded from measurements.

## Offline validation

A one-shot in-memory diagnostic imported the actual selected adapter and wrapper
through the existing tsx loader. It injected a fake fetch and a fake receipt
with model plus prompt_tokens=123, completion_tokens=7, cached_tokens=30.
No real credential or network was used. It observed:

| Probe | Result |
| --- | --- |
| Completion result | string; usage/model receipt unavailable to caller |
| Wrapper cap forwarding | max_tokens=256 in fake request |
| Caller signal forwarding | listener attached through wrapper |
| Abort listeners after successful complete | 0 before; 1 after |
| Already-aborted caller | second fake fetch launched; transport signal aborted=false |
| Measured completion method | absent |
| Provider generation calls | 0 |

This diagnoses missing capability; it does not simulate billed usage or prove a
provider ignores max_tokens. No generation was made simply to test availability.
The diagnostic process exited, reaping its timers/listeners with it.

Existing focused baseline checks:

```sh
npx vitest run tests/unit/llm/deepseek-client.test.ts \
  tests/unit/llm/classifier-box.test.ts --reporter=dot
```

**16 tests / 2 files passed**, Vitest duration 151 ms. These existing tests cover
classification cancellation/request shaping/naming and wrapper behavior; they
are not new reranker/measured-call tests and do not establish cap enforcement,
receipt propagation or cleanup. No red/green reranker implementation was started.
No unrelated full suite, build, backend or live corpus test was run. The repo
has no `.agent-quality.yml`; no configured preflight gate pass is claimed.

## Source identity

SHA-256 over the inspected checkout bytes (before documentation writes):

| Source | SHA-256 |
| --- | --- |
| `src/ports/llm-client.ts` | `c7568e7e9c76cc9e67b6bca5ece6f3c9a20aefc86cc2c705cce48cfaad0365dc` |
| `src/llm/deepseek-client.ts` | `a98d82b7d93bb494e97cf3266e5a2e0594310495ce11dde94382cb864cfa3402` |
| `src/llm/classifier-box.ts` | `88817d56eeaa60fa3a2dd8e266f0072814e93aa90c89fed56979385a58b02c0e` |
| `src/llm/build-classifier.ts` | `d72c92057e048b916ac45b537d2de736308e2710908dbe48d17404b8f79993ed` |
| `src/llm/clef-client.ts` | `cacb874b5610498c8b2029d3b6d4f22d6123f84393e0be1e497a1bb92d85ef96` |
| `scripts/eval/memory-context.ts` | `5ac676082e61d29499c8d7855763440ba16ce73a0e2b01b8dabfcfdf9eecadbb` |
| `src/core/eval/context/run.ts` | `f8fffd65fface0de66b7dca1982345151bbcc1afd32a505e4c950265752d04a0` |
| `src/core/eval/context/types.ts` | `4cc1239c92eb6ff1d284c20d801cdb82ab971faedfd69e992572cd7c98fbdee4` |

No full secret-bearing config hash or raw metadata response was persisted. No
snapshot, DEV cases/vectors or holdout files were opened by this task; no new
source/dataset hash is claimed. Tasks 7/8 scientific no-go remains in force.
The initial read-only NLM recall provided no evidence used in this decision;
no citation is claimed.

## Unavailable outcomes and follow-up

Admission tokens, provider/cached/billed/failed-call usage, reader tokens,
chain totals and tokens per supported answer are null/unavailable. Blinded
quality delta, bootstrap bounds, targeted gain and model-stage p95 are
null/unavailable. Experiment query/triggered/skipped/failed/timed-out counts
are unmeasured because no experiment began; operational zero calls must not be
substituted for an experimental denominator. No measured <5 pp gain, >1.10x
cost or latency-budget failure is claimed. No prompt/trigger/tokenizer/model
revision was registered as qualified. The durable document states precise
capability reopening steps and all original thresholds; holdout remains sealed.

Cleanup: no new worktree, subprocess daemon, API state, corpus write, migration,
installed config change, deployment, push, provider or private experiment
artifact was created. No speculative code/tests were added. This shared task
worktree is retained for root's independent review and final Task 10 landing.
Validation passed: `git diff --check`, staged `git diff --cached --check`,
nine existing local-link targets, and unchanged `src/`, `scripts/`, `tests/` and
package files against the baseline. The complete staged diff was inspected;
only this report and the durable experiment document were staged.
