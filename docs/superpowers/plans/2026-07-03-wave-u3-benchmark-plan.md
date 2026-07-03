# Wave U3: Benchmark + Credibility Assembly (#310, #222, #223) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** One public benchmark page whose every number is reproducible or clearly caveated, committed homes for the usefulness measurements (including the negatives), a README where every claim traces to a measurement, and the private-corpus bench harness skeleton that runs only against an Edward-locked query file.

**Architecture:** Assembly, not measurement: all numbers already exist (scout: .superpowers/sdd/u3-scout.md). New reports/ files give the usefulness story a repo-visible home; docs/benchmarks.md assembles; README links. The #223 harness is a skeleton that refuses to run without a locked query file, keeping all private content out of the repo.

**Measured inputs (u3-scout, 2026-07-03, load-bearing):**
- Public reproducible LongMemEval-S number: hybrid R@5 96.5 (n=200, body-only, reports/longmemeval/2026-06-22-03-14-49-body-only). The README's 97.2 is the 2026-05-26 n=500 run; both are honest, the page must label which is which.
- Usefulness numbers have NO repo-visible home today (they live in gitignored .superpowers/sdd/ artifacts + plan text).
- README defects: tests badge 726 (actual ~1,789 cases / 245 files), hooks badge 3 (actual 4), stranger-sim report unlinked, L347 74.4% decision-precision claim has no locatable repo source, L487 dev comment stale.
- Funnel today (controller-fetched 2026-07-03): npm last-week downloads 113 (2026-06-26..07-02), GitHub stars 7, forks 0, watchers 0.
- #222 NOT locked (0 KEEP/EDIT/DROP marks): the harness ships as a skeleton; the query review is surfaced to Edward.

## Global Constraints

- PUBLIC repo: no internal hostnames, LAN IPs (localhost/127.0.0.1 fine), home paths, client or unreleased-venture names in committed text. The private-bench queries contain client names: NO query text, subject, or gold session id from the operator's private bench directory (outside the repo) may appear in any committed file. Aggregate numbers only, and none exist yet.
- Every number on the benchmark page and README must either (a) trace to a committed reports/ or docs/ file, or (b) carry an explicit "not independently reproducible" caveat. Negative results are published with the same prominence as positives.
- Competitor figures: ONLY from a fetched, cited public source (URL + date accessed). If a claimed figure cannot be verified at implementation time, omit the competitor rather than approximate. Never present numbers from different benchmark setups as directly comparable; state the setup difference.
- No em dashes in added text. No literal NUL bytes. No narration comments. No new dependencies.
- Gate per task: `npm run typecheck` + `npm test` green.
- Worktree `.worktrees/u3-benchmark`, branch `feat/u3-benchmark`; one writer in the tree at a time.

---

### Task 1: committed homes for the usefulness story + funnel baseline

**Files:**
- Create: `reports/usefulness/2026-07-03-consumption-measurements.md`
- Create: `reports/funnel/2026-07-03-baseline.md`

**Interfaces:**
- Produces: two committed reports that docs/benchmarks.md (Task 2) and README (Task 3) cite by relative link.

- [ ] **Step 1: consumption measurements report**

Write `reports/usefulness/2026-07-03-consumption-measurements.md` restating (aggregates only, judge = locked qwen3.5:4b usefulness judge, scripts/eval/lib/usefulness-judge.ts):
- Ambient per-prompt injection (hook-usefulness instrument): usefulness 18.2%, off-topic 81.8%.
- Thin-prompt band (hook-usefulness --band=thin, days=45, n=19 scored): usefulness 7.9%, off-topic 89.5%, cited 0%.
- Context-augmentation A/B (context-recall-ab, n=40 paired thin fires): bare 28.7% useful / 67.5% off-topic; augmented 31.3% / 57.5%; delta +2.5pts vs the pre-registered +10pts ship gate: NOT SHIPPED. State the pre-registration explicitly; this negative is part of the story.
- Pull path (pull-usefulness, 2026-07-03): 3,920 raw pulls, 195 genuine after strip set, 78 joined to transcripts and scored; usefulness@pull 72.4% (52 used, 9 partial, 17 unused), off-topic 21.8%; session pulls 66.7%, fact pulls 88.1%.
- Intent distribution (14d, n=640): lookup 99.1%, relational 0.9%, temporal 0%; decision: temporal knowledge graph not built, telemetry stays on.
- Consequence shipped: pull-first posture (#392), per-prompt ambient recall off on fresh installs.
- Method notes: what "genuine pull" means (fixture strip set), what the judge sees, why join rate is 40%, and that raw artifacts are local eval outputs not committed (aggregates restated here are the citable record).

- [ ] **Step 2: funnel baseline report**

Write `reports/funnel/2026-07-03-baseline.md`: npm last-week downloads for package `nlm-memory` (fetch fresh: `curl -s https://api.npmjs.org/downloads/point/last-week/nlm-memory`), GitHub stars/forks/watchers (`gh api repos/pbmagnet4/nlm-memory`), record the fetch date and exact commands so the next measurement is comparable. Controller's 2026-07-03 fetch for reference: 113 downloads (2026-06-26..07-02), 7 stars, 0 forks, 0 watchers; re-fetch and record YOUR numbers, not these.

- [ ] **Step 3: gate + commit**

Run: `npm run typecheck && npm test` (docs-only; suite must stay green).

```bash
git add reports/usefulness/2026-07-03-consumption-measurements.md reports/funnel/2026-07-03-baseline.md
git commit -m "docs(reports): committed homes for the consumption measurements and the adoption funnel baseline"
```

### Task 2: the public benchmark page

**Files:**
- Create: `docs/benchmarks.md`

**Interfaces:**
- Consumes: reports/longmemeval/2026-06-22-03-14-49-body-only/summary.md, reports/longmemeval/2026-05-26-22-47-07/summary.md, docs/classifier-tiers.md, docs/methodology-recall-baseline.md, Task 1's reports.
- Produces: the page Task 3's README links to.

- [ ] **Step 1: write docs/benchmarks.md with exactly these sections**

1. **What we measure and why** (3-4 sentences: retrieval quality, classifier quality, and whether agents actually use what is recalled; negatives published).
2. **LongMemEval-S retrieval**: headline table from the 2026-06-22 body-only run (keyword/hybrid R@1/3/5, n=200) as THE reproducible number; the 2026-05-26 n=500 hybrid 97.2 presented as the 14-month-private-corpus run with the frontier-labels caveat quoted from docs/methodology-recall-baseline.md; by-question-type table; reproduction commands verbatim from the scout (fetch-dataset.sh + run-harness flags + npm aliases).
3. **Classifier tiers**: the measured tier table from docs/classifier-tiers.md (floor/mid/cloud rows with schema/label/entityF1/decisionF1/calibration/p50) + `nlm eval --classifier` command; link the full doc.
4. **Does the memory get used?**: the consumption story from reports/usefulness/2026-07-03-consumption-measurements.md: ambient 18.2% (thin band 7.9%), the A/B no-ship (+2.5 vs pre-registered +10: we did not ship it), pull 72.4% (facts 88.1%), and the pull-first posture that followed. Frame the no-ship as method, one short paragraph.
5. **Comparisons**: attempt to verify published LongMemEval figures from Zep and mem0 (and Letta if verifiable) by fetching their public engineering blogs/papers; cite URL + access date + THEIR setup (which LongMemEval variant, which metric: answer accuracy vs retrieval recall). LongMemEval-S retrieval R@5 is NOT the same metric as end-to-end QA accuracy; say so and do not rank across metrics. If verification fails for a vendor, omit them. If all fail, the section is one paragraph: "published figures use different variants/metrics; direct comparison would be dishonest; run `nlm eval` yourself."
6. **Private-corpus benchmark**: 2-3 sentences: a 50-question benchmark on the operator's real 14-month corpus is being locked (categories listed generically: decision-recall, status-check, bug-resolution, config-lookup, temporal, multi-session); results will publish as aggregates only. NO query content.
7. **Reproduce everything**: consolidated command block.

- [ ] **Step 2: hygiene self-check**

Python byte-scan your added text for em dashes/NULs; verify no path outside the repo, no client names (grep your new file for /Users/ and known client or venture names).

- [ ] **Step 3: gate + commit**

```bash
git add docs/benchmarks.md
git commit -m "docs: public benchmark page (LongMemEval-S, classifier tiers, consumption story with negatives)"
```

### Task 3: README truth pass

**Files:**
- Modify: `README.md` (badges, benchmark section, tests line, stranger-sim link, links to new pages)

- [ ] **Step 1: fix the quantitative claims**

- Tests badge + L487 dev comment: count the real suite (`npx vitest list 2>/dev/null | wc -l` for cases; `find tests -name "*.test.ts" | wc -l` for files) and update both to the measured values, rounding DOWN to a stable claim (e.g. "1,700+ tests").
- Hooks badge: 3 -> 4 runtimes (body already says four).
- L36 prose runtime list vs 9-row table: make the prose say nine or enumerate consistently with the table.
- The 97.2 R@5 sentence: keep the 14-month-corpus number but add the reproducible public-run number beside it in one sentence ("hybrid R@5 96.5 on the public LongMemEval-S harness run, n=200; see docs/benchmarks.md") and link the page.
- L347 74.4%/58.7% decision-precision parenthetical: search reports/ for a file recording task #320's comparison; if found, leave the numbers and add the pointer; if NOT found, replace the parenthetical with a pointer to the measured floor-tier rows in docs/classifier-tiers.md and drop the unsourced numbers.

- [ ] **Step 2: surface the credibility assets**

- Add a short "Proof" or equivalent subsection (place near the benchmark paragraph): link reports/stranger-sim/2026-06-10-recovery-simulation.md with a one-line description (a context-free agent on a fresh install recovered a months-long decision arc in minutes; exact wording from the report's own summary, do not embellish).
- Link docs/benchmarks.md and reports/usefulness/2026-07-03-consumption-measurements.md where the README discusses recall quality.

- [ ] **Step 3: quickstart sanity check**

Follow the README quickstart commands against the current code (read src/cli + package.json bin entries; do NOT run installs against the live machine): flag and fix any command that no longer exists or renamed flags.

- [ ] **Step 4: gate + commit**

```bash
git add README.md
git commit -m "docs(readme): truth pass, every claim traces to a measurement (#310)"
```

### Task 4: private-corpus bench harness skeleton (#223)

**Files:**
- Create: `scripts/private-bench/run-harness.ts`
- Create: `scripts/private-bench/README.md`
- Test: `tests/unit/scripts/private-bench-loader.test.ts` (or the repo's existing pattern for script-adjacent tests; check where scripts/ logic is tested today and follow it; if scripts/ has no test pattern, put the loader in `scripts/private-bench/locked-queries.ts` and test that module)

**Interfaces:**
- Consumes: the locked-queries JSON contract defined below; the existing recall path (mirror how scripts/longmemeval/run-harness.ts queries; reuse its lib functions where importable rather than copying).
- Produces: a harness Edward can run once #222 locks; a documented refusal before that.

- [ ] **Step 1: pin the locked-file contract in scripts/private-bench/README.md**

Path comes ONLY from env `NLM_PRIVATE_BENCH_QUERIES` (no default inside the repo tree). Format: `{ "locked": true, "lockedAt": "YYYY-MM-DD", "queries": [{ "id": string, "category": string, "question": string, "goldSessionIds": string[] }] }`. The harness REFUSES (exit 1, clear message) when: env unset, file missing, `locked !== true`, or zero queries. Output goes to the directory named by `--report-dir` (REQUIRED flag, no default), summary.md + results.json, aggregates and per-category rows only; question text is never written to the report (ids + categories only). State plainly: query files stay outside the repo; reports from real runs stay outside the repo too.

- [ ] **Step 2: implement the loader with tests, then the skeleton runner**

Loader module validates the contract above (each refusal case unit-tested with temp files). Runner: parse `--modes keyword,semantic,hybrid --limit N --k N --report-dir <path>` (mirror longmemeval harness flags), load queries, execute recall per query against the daemon or an in-process service the same way run-harness.ts does (reuse its search invocation; if reuse requires exporting a helper from scripts/longmemeval/lib, do the minimal export), score R@k against goldSessionIds, write summary. Smoke path: a `--dry-run` flag that validates the locked file and prints the plan without querying.

- [ ] **Step 3: gate + commit**

Run: `npm run typecheck && npm test`

```bash
git add scripts/private-bench tests
git commit -m "feat(eval): private-corpus bench harness skeleton, runs only against a locked query set (#223)"
```

### Task 5 (controller): reviews, merge, board, CHANGELOG

- [ ] Per-task Sonnet reviews (Task 2 reviewer gets an explicit fabrication check: every number on the page cross-checked against its cited source file; every competitor figure verified against its fetched URL or the competitor omitted).
- [ ] Opus whole-branch final review (public credibility surface; leak check over the whole diff: nothing from the private bench directory, no client names).
- [ ] Python byte-check hygiene gate; public scrub; `git pull --rebase origin main`; merge; push; CI watch with run-identity verification.
- [ ] Board: #310 -> Done (truth pass + benchmark page + funnel baseline, commit ids); #223 -> note skeleton shipped, blocked on #222 lock; #222 -> dated note surfacing the review to Edward (mark [KEEP]/[EDIT]/[DROP] in the private queries draft, then a session converts it to the locked JSON). CHANGELOG entry.
