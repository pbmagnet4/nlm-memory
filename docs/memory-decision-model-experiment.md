# Decision-model reranking: inconclusive / no-go

T806 Task 9, 2026-10-16. No model-stage candidate qualifies for Task 10.
This is a capability preflight stop, not a measured quality, cost or latency
failure. No reranker, measured-completion API, model-role setting, prompt,
trigger, state or runtime overhead was added. Held-out cases remain sealed.

The [binding spec](superpowers/specs/2026-10-16-memory-retrieval-improvements.md)
(section 4, Experiments; section 5, Measurement) explicitly permits no-go when
accounting or bounded generation cannot be qualified. Availability alone does
not justify adding an unused framework or making generation calls.

## Verified capability boundary

Audited source: `74afcfad32e56dc3aa4562e6f60a15cc405b6713`.
Only allowlisted nonsecret configuration values and filtered read-only gateway
metadata were inspected; no generation request was sent.

| Capability | Primary evidence | Qualification |
| --- | --- | --- |
| Configured lane | `~/.nlm/.env`: `NLM_CLASSIFIER=openai`, model `litellm-classifier`, base `http://192.168.2.2:4000`; no process overrides or configured max-token override | Agency gateway port 4000; not the MetaZoo gateway |
| Selected adapter | [buildClassifier](../src/llm/build-classifier.ts) and [ClassifierBox.construct](../src/llm/classifier-box.ts) | OpenAI-compatible lane uses `DeepSeekClient` with `responseFormat: "none"`; the class name does not select DeepSeek's public endpoint |
| Live role resolution | Read-only `GET /model/info`: two `litellm-classifier` deployments, both `openai/gemma-4-12B-it-qat-oQ4e-mtp`; `GET /v1/models` advertises the alias | Reported alias/deployment IDs do not pin immutable weights or tokenizer revision; no separate decision-named chat role was returned |
| Existing Clef decision capability | Read-only `GET /config/pass_through_endpoint`: authenticated `/clef/v1/systemone`; [askClef](../src/llm/clef-client.ts) defaults to `clef-oQ4e` | Separate structured decision endpoint; returns answers/ms, without usage, a chat output-token cap or caller-signal composition. Ingest gate is configured off; it is not a measured completion adapter |
| Completion boundary | [LLMClient.complete](../src/ports/llm-client.ts), [DeepSeekClient.complete](../src/llm/deepseek-client.ts), ClassifierBox forwarding | Returns a string. Response usage/model receipts are discarded. No measured completion capability or failed/timed-out request reconciliation is exposed |
| Output limit | Selected adapter emits `max_tokens: opts.maxTokens ?? classifyMaxTokens` | A 256-token request parameter is forwarded offline; provider enforcement is unverified. No live cap test or actual output measurement was performed |
| Cancellation/cleanup | Selected adapter installs an anonymous caller abort listener and clears only its timeout in `finally` | Offline probe found one listener retained after success and a fetch launched with an un-aborted transport signal for an already-aborted caller; bounded-call qualification fails |
| Evaluator/token counter | [evaluation CLI](../scripts/eval/memory-context.ts) rejects non-null tokenizer metadata and supplies `tokenizer: null`; [TokenCounter](../src/core/eval/context/types.ts) is only an injection seam | No pinned actual consumer counter; installed JS transformers is not evidence of one. Hook `estTokens` is a character estimate |
| Reader/accounting | CLI `literal-bundle-reader@1` emits `usage: null`; [accounting seam](../src/core/eval/context/run.ts) preserves unavailable token totals | Extractive containment diagnostics cannot certify blinded supported-answer quality, billed/cached usage or the cost gate |

The offline fake receipt supplied prompt/completion/cached usage and a model;
`ClassifierBox.complete` still returned only text. The wrapper forwards the
signal/maxTokens options but cannot restore discarded receipts. The evaluator's
cached embedding proxy supports only embedding and rejects non-embedding calls;
its logical attempt accounting is not provider billing evidence. Existing test
fakes cover classification/naming and do not establish measured completion.
Unsupported adapters were not changed or enabled.

## Decision and unavailable measurements

Exact admission input tokens, provider prompt/completion usage, cached/billed
categories, failed/timed-out-call usage, reader I/O, total/incremental chain
tokens, tokens per supported answer and their baseline ratio are **null /
unavailable**. Blinded quality delta, grouped confidence bounds and model-stage
p95 latency are also **null / unavailable**. No DEV experiment was started:
triggered/skipped/timed-out/failed query counts are not measured. There were
zero generation calls initiated by this task; that operational count is not a
zero-cost experimental result. No candidate, trigger or prompt was frozen for
promotion, and no holdout cases, labels or outcomes were opened.

## Reopening criteria

First qualify the existing configured client boundary and only its selected
adapter: preserve text callers, expose provider/gateway model and exact usage
receipts through wrappers, retain cached/billed categories when supplied, and
reconcile failed/timed-out requests. Unknown usage stays null. Prove actual
provider enforcement of the 256 output-token cap, pre-aborted/expired no-call
behavior, remaining-deadline cancellation and listener/timer cleanup. Keep
classifier-extraction accounting separate; never repeat it on ordinary recalls.

Then pin the actual consumer tokenizer, resolved role/model revision and an
independent reader. Freeze a DEV-derived ambiguity trigger independent of
classifier self-confidence, prompt, complete run manifest and denominator before
outcomes. Admit at most eight supplied candidates and 3,000 measured input
tokens; keep output at most 256 tokens within the remaining request budget
(default 1,500 ms). Audit all quality disagreements/no-answer errors and a seeded
10% of agreements against original text. Count all queries and stages, including
skips, failures, expansions, initial context, tool overhead and reader usage.

Before registering a disabled candidate require >=5 percentage-point targeted
sufficient-evidence gain, no overall observed quality decline, grouped paired
bootstrap 95% overall lower bound >=-2 percentage points, tokens per supported
answer <=1.10x baseline and p95 within the shared budget. Deterministic tests
must reject invented IDs/quotes, malformed output, excess input/output and
expired budgets; prove abstention/failure retains baseline evidence, makes no
fact writes, and preserves authenticated tenant/source/version gates. Those
reranker tests were not implemented here because preflight stopped first.
Task 10 retains independent preregistered held-out promotion responsibility.
