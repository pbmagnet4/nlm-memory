# Evaluation evidence and limits

NLM has several kinds of evidence. Retrieval recall, generated-answer usefulness, classifier quality and engineering regression checks measure different things.

| Study | Recorded result | Interpretation and limits |
|---|---|---|
| Historical LongMemEval-S retrieval baseline | 97.2% R@5 over 500 queries in hybrid mode | Measures annotated source retrieval in the recorded body-only setup. It is not answer accuracy or a universal current-version result. [Method and configuration](methodology-recall-baseline.md). |
| Historical personal-corpus baseline | 36/40 curated decision queries retrieved within five hits | A small, selected private corpus study; not independently reproducible from public data. [Benchmark context](benchmarks.md). |
| July 2026 recall-impact replay | The recorded pilot/run report reports passing its frozen gates | One corpus and a model judge; replay generation, prompt truncation and selection limit generalization. [Run report](../reports/replay-eval/2026-07-22-recall-impact.md). |
| October 2026 retrieval diagnostic | Scientific promotion remained inconclusive | Literal evidence containment and engineering canaries do not establish independently blinded answer quality or token savings. [Results and limitations](memory-retrieval-results.md). |
| October 2026 property-association evaluation | Automatic ownership/relevance lanes rejected | Exact subjects misidentified owners; verified quotes could name dependencies; classifier entities could come from quoted evaluation inputs. The study stopped on decisive failures rather than reporting precision from incomplete labels. |

## Property inference: why the default remains off

A source quote saying an application must install a connector library does not make the application's packaging requirement a fact owned by that library. Likewise, a project mentioned inside an evaluation transcript is not automatically a project that the labeling session concerns.

The source candidate separates explicit/operator assignments and repository relevance from experimental fact/entity inference. No corpus-wide ownership precision claim is made. Future promotion requires new source-disjoint, independently labeled cases, explicit owner/dependency/quoted-input negatives, zero wrong-owner assignments in the frozen review set and at least 95% session-reference precision. Those sample gates are acceptance criteria, not a population-level precision guarantee.

[Property association coverage](../scripts/eval/property-association-coverage.ts) is a read-only diagnostic. It counts matcher proposals, not verified correct assignments. Do not present its coverage as precision.

## Engineering evidence

SQLite and PostgreSQL contracts exercise source anchoring, property isolation, corrections, lifecycle boundaries and recall surfaces. CI checks type safety, tests and builds. The [synthetic demo](demo.md) checks a small storage-level workflow without models or real transcripts. None of these replaces an answer-quality evaluation.

Use the configuration, dataset, dates and limitations attached to each report. Older reports may describe versions that are no longer the current release. Do not combine their figures into a new headline score.
