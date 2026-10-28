# Property inference evaluation design (T1142)

Status: design only, 2026-10-28. No code in this change. Public issue: pbmagnet4/nlm-memory#57.

T1130 rejected every automatic lane (subject: f033; verified quote: q026, q073; entity-only session reference: s032) and shipped with `NLM_PROPERTY_INFERENCE=0`. This document specifies the evaluation that a revised inference candidate must pass before that flag changes. It does not specify the candidate; whatever candidate is built is frozen first (§4) and then measured exactly as written here.

Private T1130 artifacts (`~/.nlm/evaluations/T1130/`) are cited by case ID and count only. Nothing in this file quotes session content, names, paths or digests from them.

## 1. Questions and frozen gates

The evaluation answers two questions about a frozen candidate on a frozen, source-disjoint holdout:

| Q | Gate | Unit | Numerator | Denominator | Abstentions |
|---|---|---|---|---|---|
| Q1 Does the fact lane ever assign a fact to the wrong owner? | zero wrong-owner | one proposed fact assignment (fact, slug) | assignments whose reference label is `owner != slug` (includes `dependency`, `runtime-namespace`, `quoted-input`, `ambiguous`, `none`) | every assignment the candidate proposes in the holdout: a census, not a sample | an abstention is not an assignment; it never enters Q1. Abstentions are counted separately as coverage (§5) |
| Q2 Are entity-derived session references relevant? | ≥95% session-reference precision | one proposed (session, slug) reference | references labelled `relevant` | all proposed references drawn into the session strata (§2) | same: abstention is coverage, not precision |

Q1 computation. Wrong-owner is a count, and the gate is `count == 0` over a census of N proposals. With zero observed errors, the rule of three gives a one-sided 95% upper bound of 3/N on the true wrong-owner rate: N=60 → 5%, N=100 → 3%, N=120 → 2.5%. The gate is only meaningful with **N ≥ 100 proposals** (bound ≤ 3%); the report states the bound alongside the zero. Below N=100 the run reports "under-powered", not "passed". Q1 is also evaluated per failure stratum (§2): a zero overall with an empty dependency stratum is reported as such, not as evidence on dependencies.

Q2 computation. Precision is post-stratified (§2) and reported with a Wilson 95% interval. Gate: post-stratified point estimate ≥ 0.95 **and** Wilson lower bound ≥ 0.90. At N=100 references that allows at most 1 error (lower bound 0.946); at N=200, at most 4. Minimum **N = 100 labelled references**; the design targets 160 so that a single disputed label does not decide the run. Every stratum's raw precision is reported; no stratum may be below 0.80 (a catch for a failure class hidden by reweighting).

Both gates are acceptance criteria for one candidate on one holdout. They are not a population precision claim; the report says so in its first paragraph, as `docs/evaluations.md` already does.

Yield reality check (live corpus, 2026-10-28, read-only): the current quote lane would propose about 47 fact assignments across 1,103 active verified-quote facts, and about 4 per day on fresh ingestion; entity references run at roughly 140 per day. Q2 fills in days; Q1 does not. §2 and the open questions address this.

## 2. Sampling

### Source-disjointness

A holdout case is admissible only if it is disjoint from every T1130 label source on all of:

- **Session:** the case's source session ID is not one of the 190 distinct sessions behind the T1130 original and literal samples, nor shares their source identity (`runtime` + `runtime_session_id`), nor is a `parent_session_id` ancestor or descendant of one. The exclusion list is written once from the two T1130 sample files and hashed into the manifest.
- **Assertion:** the fact's `assertionKey` (normalized kind/subject/predicate/value/quote) does not equal any T1130-labelled fact's key. The same claim re-extracted from a new session is still tuning evidence.
- **Time window:** primary holdout sessions have `created_at` strictly after the freeze timestamp (§4), which is itself after the latest T1130 source (created 2026-10-27). Nothing labelled in T1130 can appear by construction.
- **Runtime and repo** are not disjointness axes (claude-code is 70% of the corpus and every T1130 source runtime is still live). They are stratification quotas instead: the holdout must contain at least 15 fact cases and 30 session cases whose runtime is codex, pi or opencode, and at least 10 distinct repository scopes among fact-case sources.

The draw is deterministic: order candidates by `sha256("T1142-v1:" + id)`, exactly as `property-activation-sample.ts` does, under a new seed.

### Strata

Stratum predicates use only source text and session metadata, never the candidate's output, so selection cannot leak the prediction. Predicates are frozen and hashed with the manifest.

| Stratum | Lane | Predicate (on source, not on prediction) | Target |
|---|---|---|---|
| A owner vs dependency | fact | verified quote names ≥2 catalog properties, or one property next to an install/depend/require/import/plugin verb | every proposal that matches; floor 25 |
| B runtime namespace | fact | quote or value contains a path, reverse-DNS, port, env-var or identifier token within 40 chars of a catalog name | every proposal; floor 20 |
| C quoted evaluation input | fact + session | session `skill` or label indicates eval/label/review/replay work, or body contains fenced blocks quoting other sessions | every fact proposal; 30 session refs |
| D entity-only reference | session | session has catalog-matching entities and no repository or explicit association | 100 session refs, half from multi-property sessions |
| E natural distribution | fact + session | uniform hash order over all remaining admissible proposals | remaining fact proposals to reach N≥100; 30 session refs |

Fact strata are a census of proposals: every assignment the candidate makes in the window is labelled, then tagged with its stratum. Session strata are samples. T1130's 20 "unresolved mixed" abstention cases are reproduced as a non-gate coverage sample: 20 abstentions from multi-property sessions, labelled to measure how often abstention was the right call.

### Reweighting

Q2 reports precision per stratum and a post-stratified estimate: each stratum's precision weighted by that stratum's share of all proposed references in the window (population counts recorded in the manifest at draw time). Q1 is a census and is not reweighted. Where strata overlap (a C session may also be D), a case belongs to the first matching row in table order and the overlap count is reported.

## 3. Blinding and labelling

**Blinding.** A label card contains: the fact (kind, subject, predicate, value) or the session's first user turns, up to 1,000 characters of source context around the quote or entity, the runtime, and the full catalog list (slug and label only). It never contains the proposed slug, the lane, the attribution source, the matcher evidence string, or the stratum. Cards are shuffled across strata and lanes. Cards are generated by the draw script and hashed before any prediction is computed; predictions are written to a separate file the labeller cannot open until labels are sealed (§4).

**Labellers.** Two labellers per card:

- L1, Edward. Labels every fact proposal (target 100–120 cards) and 160 session-reference cards. Fact cards take about 40 seconds with the catalog visible, session cards about 20 seconds: roughly 75 minutes of fact labelling and 55 minutes of session labelling, split into three sittings of under 45 minutes. His labels are the reference.
- L2, a model labeller: Qwen on the Studio lane via LiteLLM (private corpus stays local; $0). Same cards, same schema, same blinding, temperature 0, one pass, prompt hashed into the manifest. L2 labels the full card set plus the 20 abstention cards.

L2 bias containment: L2 is never shown the catalog in the same order as L1's card nor the stratum; its prompt forbids guessing from path fragments and asks for a one-line justification citing the card text. L2 is never used to decide a gate. Its uses are (a) inter-annotator agreement with L1 (Cohen's kappa on `owner` for facts, on `relevant` for sessions; report the number, with kappa < 0.6 flagged as a schema problem), and (b) a second opinion on cards L1 marks `unsure`. If L1 and L2 disagree on a card that is a proposal, the card stays with L1's label and the disagreement is listed in the report. No label is ever edited after predictions are unsealed.

**Label schema.** Fact card: `owner` ∈ {catalog slug, `none`, `ambiguous`}; for every catalog name that appears in the card, a `role` ∈ {`owner`, `dependency`, `runtime-namespace`, `quoted-input`, `incidental`}; `confidence` ∈ {sure, unsure}; optional free-text note. Session card: for each catalog property the labeller sees as relevant, `relevant`; the labeller is asked separately whether any catalog name in the card is `quoted-input-only` or `boilerplate-only` (AGENTS/CLAUDE preambles, environment listings), which forces the s032 distinction to be made explicitly.

**Adjudication.** `ambiguous` and `unsure` fact cards are correct-abstain cases: a proposal on such a card is a wrong-owner for Q1 (the candidate must abstain where a human cannot decide from the source). Session cards marked unsure are adjudicated by L1 after reading up to 3,000 more characters of the source; if still unsure, the card is dropped from the denominator and counted under annotation limits.

**Annotation limits recorded.** Number of cards, cards per stratum, cards dropped, unsure counts, L1 total time, L1/L2 kappa, cards where L1 changed a label on adjudication, and the statement that L1 is the system's operator and not a disinterested annotator.

## 4. Freeze procedure

Order is mandatory; each step writes to the manifest.

1. Candidate freeze. The candidate commit SHA (inference code in `src/core/properties/`, catalog export, thresholds, env flags, stratum predicates, card generator, L2 prompt) is recorded and the tree hash is signed into `manifest.json`. A regression suite (§6) must already pass on that SHA.
2. Catalog freeze. Export the 67-entry canonical catalog with no guessed aliases; hash it. Any catalog edit after this point voids the run.
3. Window open. `freezeAt` is the manifest timestamp. Primary holdout = sessions created after `freezeAt`. The window closes when the proposal census reaches N ≥ 100 or after 28 days, whichever comes first (`windowCloseRule` is written at freeze, not decided later).
4. Draw and seal. At window close, a read-only draw against a consistent snapshot copy of the live database produces `cards.json` (blinded) and `predictions.json` (sealed, mode 0600, SHA-256 written to the manifest). Labels are written to `labels.json`; its hash is recorded in `labels.sealed` before `predictions.json` is first read by anyone or any script.
5. Score. The scoring script verifies the manifest, card, label and prediction hashes before computing anything and refuses to run on mismatch.

**Contamination (voids the run, documented in the report, new window required):** any candidate code, threshold or catalog change after step 1; any card whose source session fails the disjointness test (§2) discovered at any time; predictions read, printed or logged before `labels.sealed` exists; labels edited after the seal; a labeller who has seen the candidate's output for that card in another context (the labelling sessions themselves are captured by NLM, so the draw window must close before labelling begins and labelling sessions are excluded by time); fewer than two runtimes represented in the fact census. Running the candidate on the window to count N (step 3) is permitted only through a script that prints the count and nothing else.

Existing T1130 labels (132 + 86 cases) remain tuning evidence. They are rerun as regressions (§6) but never counted in Q1 or Q2.

## 5. Outputs, decision rule, review

Private, `~/.nlm/evaluations/T1142/` (mode 0600, never committed): `manifest.json` (hashes, SHAs, seed, window, population counts), `exclusions.json` (T1130 source and assertion keys), `cards.json`, `labels.json` + `labels.sealed`, `l2-labels.json`, `predictions.json`, `scores.json` (per stratum, post-stratified, Wilson bounds, rule-of-three bound, coverage, kappa), `abstention-coverage.json`, `annotation-limits.json`, `contract-runs/` (test logs for §6), `review/` (independent review output).

Public, in this repo: a results section appended to this file or a sibling `docs/evaluations.md` row with counts, bounds and limits only; no case content. Public regression fixtures are fictional reproductions of each failure class (issue #57 requirement), not private cases.

Coverage is reported next to precision: proposals / eligible verified facts, references / sessions with catalog entities, and the abstention-correct rate from the 20 abstention cards. Coverage has no gate; a candidate that passes by proposing almost nothing is reported as exactly that.

**Activation decision rule.** All of: Q1 zero with N ≥ 100; Q2 point ≥ 0.95 and lower bound ≥ 0.90 with no stratum below 0.80; kappa reported; every §6 test passing on the frozen SHA on both SQLite and PostgreSQL; no contamination event; independent review returned with every finding either fixed on the branch (which re-freezes and re-draws if it touches inference code) or rejected in writing with a reason. If all hold, `NLM_PROPERTY_INFERENCE=1` is proposed to Edward with the report; it is still his call (T2 durable change). Any failed gate is a rejection of the candidate; the report is published either way so that a second rejection is not silently reinterpreted.

**Independent review.** The Muse landing review (Spark 1.3, xhigh, as T1130 used; `~/.nxtos/logs/landing-reviews/`) reviews the scoring script, the manifest chain and the contract tests, and separately re-scores a random 20% of labelled cards from `cards.json` without seeing `labels.json`; its disagreements are reported. Edward is the labeller and therefore not the reviewer of his own labels; the reviewer does not relabel, it checks the process and spot-checks.

## 6. Regression and contract tests required alongside

Unit, `tests/unit/core/properties/model.test.ts` (extend) with fictional fixtures per issue #57:

- owner vs dependency: quote "App X must install library Y" with both in catalog → abstain (q026/q073 class)
- runtime namespace: port, reverse-DNS, worktree path and env-var fragments near a name → abstain (f033 class)
- quoted evaluation input: a fenced block quoting another project's transcript inside a labelling session → no fact owner, no session reference (s032 class)
- mixed-project session: two owners asserted in one session → each fact attributed independently or abstained; never cross-assigned
- ambiguous: subject names one property, quote names another → abstain (exists; keep)
- subject-only never attributes when inference is on (f033 regression; currently only tested with inference off)
- `sessionPropertyReferences` ignores entities whose only evidence lies inside quoted or preamble regions (new input: evidence spans)

Contract, `tests/contract/property-memory.contract.ts`, run on both adapters via the existing SQLite and PG wrappers:

- `NLM_PROPERTY_INFERENCE=1` backfill is dry-run by default, idempotent, and proposes only `source-quote`/`entity` rows; never touches `operator`/`explicit`/`repository` rows
- enabling inference then disabling it removes exactly the rows it added (fail-closed re-ingestion already covered; add the enable→disable round trip)
- operator corrections win over inference on the same assertion across re-ingestion, on both adapters
- tenant isolation: inference never proposes across tenants; foreign-tenant catalog names do not match
- `session_properties` uniqueness under concurrent backfill and ingestion (PG advisory path, SQLite transaction)
- recall surfaces (`property-recall-surfaces.test.ts`): an inferred association is filterable and is labelled with its source in MCP/HTTP output, so a consumer can distinguish inferred from explicit
- evaluation harness: `scripts/eval/` draw script refuses to run on a non-snapshot path, writes 0600 files, and the scorer refuses mismatched hashes (unit tests on the hashing and refusal paths, with a synthetic SQLite fixture)

Release: full suite with PG enabled as T1130 did (3,355 passing baseline), typecheck, build, packed-plugin contract. Record counts in the report.

## 7. Effort and build order

Implementation estimate, about 4–5 engineering days plus a 2–4 week calendar wait for the window, plus about 2.5 hours of Edward's time (labelling 130 min, decision 20 min).

1. Fictional regression fixtures and unit tests for the four failure classes (red first). 0.5 day.
2. Candidate revision in `src/core/properties/model.ts` until step 1 is green, with T1130 private labels rerun as a local check. 1–1.5 days. Out of scope for this document beyond the gates it must pass.
3. Contract tests from §6 on SQLite and PG. 1 day.
4. `scripts/eval/property-holdout-draw.ts` (exclusions, strata, cards, sealed predictions, manifest) and `property-holdout-score.ts` (hash verification, per-stratum and post-stratified scores, Wilson and rule-of-three bounds, coverage, kappa), reusing the T1130 sampler's redaction and evidence helpers. 1 day.
5. L2 labelling runner against the Studio lane through LiteLLM, prompt hashed. 0.5 day.
6. Freeze (§4 steps 1–3), wait for the window, draw, label, seal, score, write the private report and the public summary row. 0.5 day of work across the window.
7. Independent review, fixes or written rejections, decision.

## Open questions for Edward

1. **Q1 yield.** At the current proposal rate (about 4 per day) a 100-proposal census needs roughly a month of fresh sessions. Options: accept the 28-day window; or admit a supplementary pre-freeze draw from the ~24,000 sessions that are not T1130 sources (session- and assertion-disjoint, not time-disjoint), reported as a separate stratum. The design assumes the 28-day window with the supplementary draw as a pre-declared fallback only if N < 100 at close. Confirm, or choose the supplementary draw from the start.
2. **Labelling budget.** About 130 minutes across three sittings is the floor for a human reference on every proposal. If that is too much, the only honest reduction is a smaller session sample (100 refs, about 35 minutes), which weakens the Q2 bound to allow at most one error; the fact census cannot shrink without weakening Q1.
3. **Review lane.** Muse landing review as reviewer and spot-checker, as in T1130, or a second model family for the 20% re-score as well.

## Amendment 2026-10-28

The text above is unchanged. This amendment narrows the evaluation scope; Edward decided it on 2026-10-28.

Reason. The conservative candidate proposes a fact owner for only 4 of 40,400 active facts corpus-wide, so the fact lane can never reach the Q1 census of N >= 100 proposals. The session-reference lane has the volume: 6,824 sessions carry catalog entity references.

New scope.
- Evaluate and activate the session-reference lane only. `NLM_SESSION_PROPERTY_INFERENCE` gates entity-name session references (ingestion and the session part of backfill). `NLM_PROPERTY_INFERENCE` now gates fact attribution only and stays off.
- The manifest records `lanes: ["session"]`, written at freeze (`--lanes session`, the only supported value).
- Window rule (replaces step 3's census rule). The window closes when at least 160 session references are available across the strata targets (C 30, D 100, E 30, each stratum capped at its target) or after 28 days, whichever comes first. `--count` prints that number.
- Draw emits session cards plus the 20 abstention cards. No fact cards are drawn.
- Scoring omits Q1 from the decision rule and reports it as "out of scope (fact lane off)". Q2 gates are unchanged: point estimate >= 0.95, Wilson lower bound >= 0.90, stratum floor 0.80, N >= 100 references.
- Labelling effort is about 55 minutes (about 160 session cards plus 20 abstention cards).

The fact lane is deferred until a candidate yields enough proposals to reach a Q1 census.
