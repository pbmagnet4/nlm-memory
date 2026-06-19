# Code-exemplar recall: "what code worked for a task like this"

Status: SHIPPED (v0.13.0–v0.14.0)
Date: 2026-06-15 (designed) · 2026-06-19 (shipped)

> **Shipped.** The lane is live behind `NLM_CODE_EXEMPLARS_ENABLED=1`.
> - v0.13.0 (PR #17) — store + CodeRankEmbed embedder wired into the daemon + MCP; flag-gated capture on the signal-ingest path.
> - v0.13.1 (PR #18) — `recall_code` parity on the HTTP `/mcp` transport.
> - v0.14.0 — `PgCodeExemplarStore` (pgvector) so the lane works on both SQLite and Postgres; `recall_code` `/mcp` registration regression test.
>
> Remaining open: a code-signal **producer** to populate it from real coding runs (NocoDB #330) and a scaled **synthetic eval** (#331). Capture stays empty until a producer emits code-bearing signals.

## Thesis

NLM already learns *that* a model tends to fail a step (the signals lane: "qwen3-coder
fails `tsc` 38% in repo X"). It does not yet learn *what code succeeded or failed* for a
given kind of task. This plan adds a code-exemplar layer on top of the existing signals
lane so an agent can pull concrete precedent at implementation time:

> "Code that **passed** the gate for a task like this one — and code that **failed**, so avoid it."

This is the exemplar complement to the statistical failure-mode block. The failure-mode
block says *be careful here*; exemplar recall says *here is the specific shape that held up*.

## Prior art & positioning (researched 2026-06-15)

Two adversarially-verified research passes (academic literature + production coding-agent
products, ~47 sources, ~50 claims verified at 2/3-refute-to-kill). Verdict: **no system —
academic or product — matches NLM's full profile** (deterministic-outcome-labeled + code-as-unit
+ positive&negative exemplars + cross-session + model-agnostic). The pieces exist scattered
across different systems; the combination, and one ingredient, are unmatched.

**The unmatched ingredient: deterministic ground-truth labels with no LLM in the labeling loop.**
Every outcome-labeling system uses LLM self-judgment or LLM-interpreted ground truth — Voyager
(GPT-4 self-verification critic, [2305.16291](https://arxiv.org/abs/2305.16291)), ReasoningBank
(LLM-as-judge, no ground truth, [2509.25140](https://arxiv.org/abs/2509.25140)), ReMe
(LLM-as-judge, [2512.10696](https://arxiv.org/html/2512.10696v2)), Mem0 (LLM extraction +
confidence, explicitly "rather than deterministic verification"). NLM's git-survival + test-exit-code
derivation is unmatched among examined systems. (A verifier explicitly tested the strongest
counter-candidate as prior art and killed it 0-3.)

**Near-miss decomposition — who holds which piece, and where each falls short:**

| System | Deterministic label | Code as unit | Cross-session | Negatives | Falls short on |
|---|---|---|---|---|---|
| **Voyager** | no (LLM critic) | **yes** | yes | no | label + positives-only |
| **ReasoningBank / ReMe** | no (LLM judge) | no (NL strategy) | yes | **yes** | label + NL-not-code |
| **Aider** | **yes** (test/lint exit codes) | no (repo map = AST structure) | no (ephemeral) | no | persistence + structure-only |
| **SWE-Bench-CL** | no (LLM success flag) | no (NL summaries) | yes | no | NL-not-code, NL-similarity retrieval |
| **SWE-agent / OpenHands** | n/a | n/a | **no (zero persistent memory)** | no | persists nothing across sessions |
| **Cline/Cursor/Gemini/Codex memory** | no (human/LLM-authored) | no (markdown/rules) | yes | no | label + code-as-unit |
| **Zep/Graphiti** | no (LLM temporal validity) | no (NL entities) | yes | no | label + code-as-unit |

Aider is the closest on *labeling* (genuinely deterministic test/lint loop) but throws the signal
away after each edit; its only persisted artifact, the repo map, is tree-sitter AST structure
ranked by PageRank, never outcome-labeled ([repomap.py](https://github.com/Aider-AI/aider/blob/main/aider/repomap.py)).
The "Inside the Scaffold" taxonomy ([2604.03515](https://arxiv.org/pdf/2604.03515)) classifies all
persistent coding-agent memory into four forms — static config, LLM-authored rules, session-state
dumps, background LLM extraction — **none** of which is deterministic-outcome-over-code.

**Well-trodden (not novel, do not claim):** code-as-skill-library + persistence + composition
(Voyager); positive+negative contrastive retrieval (ReasoningBank, ReMe); model-agnostic
non-parametric in-context experience learning (ExpeL [2308.10144](https://arxiv.org/abs/2308.10144),
Reflexion [2303.11366](https://arxiv.org/abs/2303.11366)).

**Dominant risk from prior art — "Library Drift"** ([2605.19576](https://arxiv.org/html/2605.19576),
+ Ratchet [2605.22148](https://arxiv.org/abs/2605.22148)): unbounded skill accumulation without
outcome-driven lifecycle management *silently* degrades retrieval precision below the no-skill
baseline (LLM-authored skills measured +0.0pp vs +16.2pp human-curated on SkillsBench); near-duplicate
and stale entries crowd out useful ones with no error signal. NLM's outcome-gating addresses the
*validation gap* the drift literature names as causal — but the literature is explicit that
outcome-gating is **necessary, not sufficient**. The Q3 retention design (code_hash dedup +
per-bucket cap + prune-reverted) is exactly the prescribed second half; keep it, do not drop it.

**Caveats on the novelty claim:** negative-existence findings are bounded by what docs/source
disclose. Cursor's own memory internals were inferred by architectural class, not directly
inspected. Continue.dev / Augment / Copilot did not surface dedicated evidence. Several memory
features (Cline, Gemini/Codex CLI) are actively evolving — re-check before any public novelty or
patent claim. State as of June 2026.

## What already exists (do not rebuild)

- `migrations/017_signals.sql` — `signals(id, install_scope, kind, producer, outcome, model,
  repo, step, detail, session_id, ts)`. `outcome ∈ {pass, fail, fix, exhausted}`. Append-only,
  idempotent on a deterministic id, **no embeddings by design**.
- `src/core/signals/` — `ingest-signal.ts` (boundary validation), `aggregate.ts`
  (failure-mode roll-up), `failure-mode-recall.ts`, `recommend.ts`, `install-scope.ts`.
- `src/ports/signal-store.ts` — `SignalStore` (append-only, no supersedence, no embeddings).
- Producers already emit outcomes over HTTP and session-embedded transport; `install_scope`
  already isolates tenants/machines; `NLM_SIGNALS_ENABLED` / `NLM_SIGNAL_RETENTION_DAYS`
  already gate and prune.

The outcome label is therefore **already captured at ingest**. The only missing pieces are
(1) the code content, (2) a code embedding, (3) a similarity retrieval path.

## What this adds

1. A `code_exemplars` table (sibling to `signals`, not a column on it — signals stays lean
   and embedding-free).
2. A second embedding lane (code embedder) alongside `nomic-embed-text`, behind a port so it
   degrades gracefully and stays zero-config.
3. A `recall_code` MCP tool (+ HTTP + CLI), pull-only. No change to the prompt/citation hooks.
4. Optional git-survival enrichment computed lazily at recall time.

## 1. Schema

New table, new sqlite-vec virtual table. SQLite default; mirror in `migrations/pg` for the
Postgres tier (same shape, `pgvector` column).

```sql
-- migration 0XX_code_exemplars.sql
CREATE TABLE IF NOT EXISTS code_exemplars (
  id            TEXT PRIMARY KEY,          -- sha256(install_scope|repo|code_hash|outcome)[:16]
  install_scope TEXT NOT NULL,
  signal_id     TEXT,                      -- soft link to signals.id (may be null)
  session_id    TEXT,                      -- soft link to the originating session
  repo          TEXT NOT NULL,
  model         TEXT NOT NULL,             -- model that produced the code (any vendor)
  lang          TEXT,                      -- detected language (ts, py, go, ...)
  task_context  TEXT NOT NULL,             -- one or two lines: what this code was for
  code          TEXT NOT NULL,             -- the chunk (function / hunk / file slice)
  code_hash     TEXT NOT NULL,             -- sha256 of normalized code, for dedup
  outcome       TEXT NOT NULL CHECK (outcome IN ('pass','fail','fix','exhausted')),
  git_sha       TEXT,                      -- commit the chunk landed in, if known
  survived      INTEGER,                   -- nullable; lazily filled (1 lived, 0 reverted)
  ts            TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_exemplars_scope_repo
  ON code_exemplars(install_scope, repo, outcome);
CREATE INDEX IF NOT EXISTS idx_exemplars_ts ON code_exemplars(ts);

-- vector lane (sqlite-vec); dimension set by the code embedder, NOT 768
CREATE VIRTUAL TABLE IF NOT EXISTS code_exemplars_vec USING vec0(
  exemplar_id TEXT PRIMARY KEY,
  embedding   FLOAT[<CODE_EMBED_DIM>]
);
```

`outcome` is denormalized from the linked signal so retrieval can rank without a join.
`pass`/`fix` are positive exemplars; `fail`/`exhausted` are negative ("avoid") exemplars.

## 2. Where the code comes from

The signal carries the outcome, not the code. Two sourcing paths, in priority order:

- **(a) git diff at the linked commit (preferred, fully agnostic).** For `kind ∈ {gate, test}`
  signals tied to a commit, resolve the commit from `(repo, session_id, ts)` and extract the
  changed hunks. Git is the universal substrate — works regardless of which agent or model
  wrote the code. `git_sha` is recorded; `survived` can be enriched later.
- **(b) producer-supplied code in `signal.detail.code`.** When there is no commit (a gate that
  ran pre-commit, an eval harness), the producer may include the chunk in `detail`. Opt-in;
  keeps the signals row itself lean because exemplar extraction reads `detail` once and writes
  to `code_exemplars`, not back to `signals`.

**Chunking (v1) — resolved 2026-06-15.** The embedded unit is the **whole changed hunk**,
bounded and labeled. Function-level splitting is deferred to v2 because accurate function
extraction needs per-language parsing (tree-sitter), which adds a dependency and language gaps
against the zero-config / polyglot-agnostic thesis. The tie-breaker: git already provides a
free, language-aware function hint via its diff hunk headers (`@@ ... @@ def my_function(`,
computed by git's built-in diff drivers), so v1 stays hunk-based and still captures the
function name with no parser.

v1 rules:
- Embed the changed hunk as the unit (reuse `src/core/embedding/chunk-body.ts` for
  normalization where it fits).
- **Size band:** skip hunks under ~2 meaningful lines (non-blank, non-brace-only — a one-char
  fix is not an exemplar) and over ~200 lines (a large hunk is a feature, not reusable
  precedent, and dilutes the vector).
- Capture git's hunk-header funcname into `task_context` when present (free, language-aware).
- `code_hash` dedup handles repeats.
- **v2 refinement:** function-level split via git funcname + a brace/indent heuristic, falling
  back to the raw hunk for anything it cannot parse. Prefer this over a heavyweight parser to
  preserve agnosticism.

## 3. Embedding lane (the one real open decision)

Add a code embedder beside `nomic-embed-text`. **Constraint: must not break zero-config
local-first.** `nlm setup` currently needs only Ollama + `nomic-embed-text`.

### Eval result (2026-06-15) — open question 1 RESOLVED

Feasibility and quality both clear. `ollama pull hf.co/awhiteside/CodeRankEmbed-Q8_0-GGUF`
(146 MB Q8) loads and serves through the **existing Ollama dependency** — no new runtime,
zero-config story holds. It emits 768-dim vectors (same width as `nomic-embed-text`, but a
different space — lanes stay separate).

Retrieval eval (24-chunk polyglot corpus, 18 NL->code queries with hard near-distractors,
`/tmp/code-embed-eval.py`), each model with its correct prefixes (`search_query:` /
`search_document:` for nomic; `Represent this query for searching relevant code:` query
prefix, raw docs for CodeRankEmbed):

| Metric | nomic-embed-text | CodeRankEmbed-137M | delta |
|---|---|---|---|
| Recall@1 | 61.1% | **94.4%** | +33.3pp |
| Recall@5 | 94.4% | **100%** | +5.6pp |
| MRR | 0.731 | **0.972** | +0.241 |

The baseline's misses are exactly the adjacent-but-wrong cases (debounce vs throttle, retry
vs timeout, SQL/list ops all drifting toward one topic cluster) — the prose embedder groups
by topic; the code embedder discriminates by behavior. That gap is the whole reason to add
the lane. Caveat: 18 queries is a feasibility signal, not a production benchmark; re-confirm
on the synthetic eval corpus (section 8) at real scale.

**Decision: CodeRankEmbed-Q8 via Ollama is the default code embedder.** Embeddings are
deterministic, so no variance pass needed.

Plan:

- Define the code embedder behind the existing embedding port with a `profile: "code"`.
- **Graceful degradation:** if no code embedder is configured/available, the exemplar lane
  falls back to embedding code with `nomic-embed-text`. Degraded retrieval quality, but the
  feature still works and setup never breaks. The whole lane is off unless
  `NLM_CODE_EXEMPLARS_ENABLED=1`.
- **Model choice — validate before committing.** Candidates: CodeRankEmbed-137M (small, strong
  on CodeSearchNet, Apache-2.0) or nomic-embed-code (7B, SOTA, heavier). Open question: can a
  good code embedder be served through the **existing Ollama dependency**? If it needs a
  separate runtime, that conflicts with zero-config and the 137M-via-Ollama (or fall back to
  nomic-embed-text) path wins. Resolve with a small retrieval eval (section 6) before wiring
  a hard dependency. Do not assume the 7B model; default to the lightest thing that beats the
  nomic-embed-text baseline on code retrieval.

Dimension is whatever the chosen embedder emits; the vec table is sized to it, separate from
the 768-dim prose lane. The two lanes never share a vector space.

## 4. Outcome and git-survival

- **Primary label: the signal's `outcome`.** Already correct at ingest. No git needed for the
  base case.
- **Secondary enrichment: `survived`.** Computed lazily at recall time (not a scheduled job):
  given `git_sha`, check whether the chunk still exists in `HEAD` (or was reverted/rewritten
  shortly after). A `pass` exemplar that was later reverted is downranked. Lazy keeps it correct
  as history evolves and adds no cron surface.

### Retention (resolved 2026-06-15)

Dedicated retention, **not** `NLM_SIGNAL_RETENTION_DAYS`. Signals are statistical telemetry
whose value decays (the 90-day window keeps failure-mode aggregation dense); an exemplar is a
durable asset — a function that passed the gate is just as useful at six months, so clock-based
pruning would evict the best precedent. Bound by quality and dedup instead:

- **`code_hash` dedup** — the primary anti-bloat lever; re-implementing the same function does
  not multiply rows.
- **Prune reverted exemplars** — `survived=0` failed the durability test; low value, prune
  (lazily or on a light sweep).
- **Per-bucket count cap** — `NLM_EXEMPLAR_MAX_PER_BUCKET` (default ~20), bucket =
  `(install_scope, repo, lang, outcome-class)`, evicting oldest beyond the cap. Negatives
  (`fail`/`exhausted`) get a smaller cap — a few cautionary examples, not hundreds.
- **No primary time expiry.** Optional `NLM_EXEMPLAR_RETENTION_DAYS` default `0` = off, an
  escape hatch for users who want a hard ceiling. Existing `idx_exemplars_scope_repo` +
  `idx_exemplars_ts` cover the cap-eviction scan.

## 5. Retrieval: `recall_code`

New MCP tool (+ HTTP route + `nlm recall-code` CLI), pull-only. The agent calls it when it is
about to implement, the same way it calls `recall_facts`.

```
recall_code(query, { repo?, lang?, model?, k?=5, includeNegatives?=true })
  -> embed(query) with the code embedder (or fallback)
  -> vec search code_exemplars_vec, filtered by install_scope (+ repo/lang/model if given)
  -> rerank: pass/fix boosted; fail/exhausted returned as labeled negatives;
             survived=0 downranked; recency tiebreak
  -> return [{ code, task_context, outcome, repo, model, survived, git_sha }]
```

Returning negatives is deliberate: "here is the approach that failed the gate here" is as
useful as the positive. The caller sees both, clearly labeled.

## 6. Hooks: no change

- `UserPromptSubmit` pointer block: **unchanged.** Code is not pushed into every prompt — most
  turns are not about to write code, and chunks would bloat context. Retrieval is a pull.
- `cite_session` / citation loop: **unchanged.**
- Exemplar extraction hangs off the **daemon-side signal ingest path**, so every runtime gets
  it for free, exactly as session indexing already does. No per-runtime hook work.

## 7. Agnosticism (inherited, not re-earned)

- `install_scope` already isolates installs/tenants -> multi-user safe.
- `model` already records any vendor's model string -> Claude, GPT, Gemini, local Qwen, human.
- Outcome comes from the producer; code comes from git diff -> both vendor-neutral.
- `recall_code` over MCP -> any MCP client (Cursor, Windsurf, Codex, Gemini CLI, Aider).
- Code embedder is open-source and local.

Nothing in this plan ties to Anthropic. It learns from *what happened to the code*, not *what
wrote it*.

## 8. Eval (mirror docs/eval-signals.md)

- **Synthetic (now):** deterministic exemplar corpus across N repos / M models with known
  outcomes. Assert `recall_code` ranks `pass`/`fix` exemplars above `fail`/`exhausted` for a
  semantically similar query, scopes correctly by `install_scope`, and is idempotent on
  re-ingest. Prove the lane is correct and quiet before live data.
- **Real-data (later):** loop closure — when exemplars start surfacing for a `(repo, task)`
  shape, does the repeat-failure rate on similar tasks drop vs before? Same ROI question the
  signals lane already measures, one altitude lower (specific code, not aggregate step rate).

## 9. Build order

1. `migration 0XX_code_exemplars.sql` (+ `migrations/pg` mirror) and the vec table.
2. `CodeExemplarStore` port + sqlite adapter (`insert`, `insertMany`, `searchByVector`,
   `pruneOlderThan`), unit + contract tests.
3. Exemplar extractor in the signal ingest path: git-diff sourcing (a), then `detail.code` (b).
4. Code embedder behind the embedding port with `nomic-embed-text` fallback; pick model via a
   small retrieval eval first.
5. `recall_code` MCP tool + HTTP route + CLI, with negatives and `survived` rerank.
6. Synthetic eval (`scripts/eval/`), then wire the real-data measurement.

Each step ships behind `NLM_CODE_EXEMPLARS_ENABLED` (default off) until the eval clears.

## Open questions to resolve before coding

1. ~~Code embedder served via existing Ollama, or a new runtime?~~ **RESOLVED 2026-06-15:**
   CodeRankEmbed-Q8 GGUF pulls and serves via existing Ollama (146 MB, 768-dim) and beats the
   nomic-embed-text baseline +33pp Recall@1 / +0.24 MRR on a code-retrieval eval. Zero-config
   holds. See "Eval result" above.
2. ~~Chunk granularity for v1 — whole changed hunk vs function-level split.~~ **RESOLVED
   2026-06-15:** whole changed hunk, size-banded (~2-200 meaningful lines), labeled with git's
   hunk-header funcname, `code_hash` deduped. Function-level split deferred to v2 (git funcname
   + brace/indent heuristic, never a heavyweight parser). See "Chunking (v1)" in section 2.
3. ~~Retention: reuse `NLM_SIGNAL_RETENTION_DAYS` or a dedicated exemplar retention.~~
   **RESOLVED 2026-06-15:** dedicated, quality+dedup bounded, NOT clock bounded — signals
   decay, exemplars do not. Levers: `code_hash` dedup; prune `survived=0` (reverted) rows;
   per-bucket count cap `NLM_EXEMPLAR_MAX_PER_BUCKET` (default ~20) over
   `(install_scope, repo, lang, outcome-class)` with a smaller cap for negatives; optional
   `NLM_EXEMPLAR_RETENTION_DAYS` default `0`=off as an escape hatch only. See section 4.
4. **4-state label semantics at retrieval (uncharted — raised by prior-art research).** All
   prior art is binary pass/fail; NLM's `{pass, fail, fix, exhausted}` has no precedent to
   borrow. How is `fix` ranked — weak positive (it eventually worked) or a distinct contrastive
   class (it needed correction, here's what)? Is `exhausted` a negative or a "hard problem"
   signal? Decide empirically on the synthetic eval, not by guess.
5. **Frontier-convergence watch.** The academic frontier (SWE-Exp, Memory Transfer Learning
   [2604.14004](https://arxiv.org/abs/2604.14004)) may be moving toward deterministic-outcome-
   over-code; re-scan before any public novelty/patent claim. Negative-existence findings are
   doc/source-bounded (see caveats in "Prior art & positioning").
