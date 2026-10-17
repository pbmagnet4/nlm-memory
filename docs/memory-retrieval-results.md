# Memory retrieval integration results (T806)

Required correctness work is implemented; optional ranking, evidence deltas and decision-model reranking remain off. Final independent whole-branch review, landing, deployment and live canary are pending. This document is the aggregate results source of truth; private corpus and raw reports remain outside git.

## Frozen final diagnostic protocol

Frozen before opening heldout content. Required candidate `49dd646cbc0b2e5a83d8a11c2953bab4f7925c22` versus compact baseline `a9f072919f2f07feb053c18ffb9d21e219dcfeb2`; runtime required path is unchanged from Task 6/Task 7 default-policy integration. One contrast, candidate minus baseline; no qualified optional, combined or fallback arms. Fixed N=55 from the existing source-audited 120-question dataset (65 DEV / 55 holdout), with no sample expansion.

Primary blinded answer quality, exact consumer tokens and a corresponding development-only power estimate are unavailable. This is a literal-evidence diagnostic and remains scientifically INCONCLUSIVE regardless of its interval. The separate reader receives only question and returned bundle, never labels. Literal containment does not prove semantic answer quality.

Actual pinned TSX handlers run against separate migrated disposable clones with isolated HOME/XDG/runtime/state roots. Five fixed first-DEV questions warm each arm, baseline then candidate, before the measured alternating pairs (baseline first at index 0). A distinct same-baseline DEV control alternates five warmups and five measured pairs. This prospective choice avoids repeating Task 7's unwarmed comparison; startup/deadline artifacts can still occur and will be retained. No control repair or heldout rerun is permitted. Cached quality vectors are identical across arms, captured only through the existing configured `buildEmbedder`; these are not uncached latency measurements. All attempts and partial/failed outcomes remain in the denominators.

The single-comparison 95% diagnostic interval uses the existing paired source-family percentile bootstrap (2,000 resamples, seed 806). With one declared contrast, the familywise interval equals its individual interval. Category rows are descriptive, not additional hypothesis tests. Audit every score disagreement and no-answer error, plus ceil(10%) of remaining score agreements ordered by SHA-256 of `806:<case-id>`. Read original UTF-8 bytes without newline conversion; check ranges as UTF-16 offsets with CR preserved.

Private evidence root: `~/.nlm/eval/memory-context/2026-10-16-T806/task10-final/`.

| Frozen artifact | SHA-256 |
| --- | --- |
| Final preregistration | `1d6e57ecca95961a9a71d784ccc2f06e8dfd4e52940b85519d9c56097d9884a0` |
| Execution manifest | `1f0db151141188a9603eeff3ee696b1c26ea0a946e859c96ccfd3ad7890acb11` |
| Holdout case bytes | `bc23fb06bf33daea9bbbd991ada2eda4a72eddb6bd1aaad4955ab9f52655ba24` |
| Canonical snapshot | `08a6b4f2493ca4128b3c7ae0dac590c4d1ed1b7ba2bd0be9044859be4fbb05c7` |
| Frozen DEV vectors | `46a401d2556014cfe04013c5d700e96ac8b9f2299671ffe6da6776072f104c78` |

A warmup-order wording correction was made before either control outcomes or heldout content was opened; the superseded registration is retained privately. Exact final manifest hash is verified when reporting results.
