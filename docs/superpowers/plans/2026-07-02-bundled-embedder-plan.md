# Bundled In-Process Embedder (#363 slice 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A fresh machine with no Ollama and no LM Studio can index sessions and get correct semantic recall, via a new `NLM_EMBED_PROVIDER=bundled` embedding provider that runs nomic-embed-text-v1.5 ONNX in-process. This kills the external-embedder prerequisite for the desktop distribution (#363 slice 2 and 3 build on it). Ollama stays the default provider; every existing configuration is byte-identical in behavior.

**Architecture:** A new `BundledEmbedderClient` implements the existing `LLMClient` port embed-only, exactly like `OpenAIEmbedderClient` does (classify and rewrite throw). It lazy-loads `@huggingface/transformers` on first embed (dynamic import, so no install pays module-load cost unless the provider is selected), runs the `feature-extraction` pipeline with mean pooling + L2 normalization, applies the same `EMBED_PREFIXES` (`search_query: ` / `search_document: `) and `MAX_EMBED_CHARS` truncation as both existing providers, and asserts 768 dimensions. `buildEmbedder()` gains a `bundled` branch; `resolveEmbedderInfo` reports it; the existing `embedding_config` reconcile (startup probe) then records the lane and stale-lane detection handles any switch to or from `bundled` with zero new code.

**Dependency decision (authorized exception, this task only):** `@huggingface/transformers` (pin exact version 4.2.0). Evaluated against raw `onnxruntime-node` 1.27.0: raw ORT would still need `@huggingface/tokenizers` for the BERT wordpiece tokenizer plus hand-rolled mean pooling, normalization, and model-file download management. Each hand-rolled piece is a silent-vector-corruption risk (the exact bug class the embedding_config machinery exists to catch). transformers.js integrates tokenizer, ORT session, pooling, and hub caching in one maintained package and is the stack the task's Developer Prompt recommends. Known costs, accepted: `sharp` ships as a transitive native dep (used only for vision pipelines, dead weight here); onnxruntime-node native binaries add tens of MB to node_modules. Model weights (`onnx-community/nomic-embed-text-v1.5` or the `nomic-ai` repo's onnx export, quantized q8, ~140MB) download on first use into `~/.nlm/models/` (overridable via `NLM_BUNDLED_MODEL_DIR`); they are NOT an npm payload.

**Vector-space note:** bundled ONNX q8 output is close to but not identical to Ollama GGUF or LM Studio MLX output. Lanes must never mix silently; they cannot: `embedding_config` records provider+model+dim and the startup reconcile degrades semantic recall to keyword and tells the operator to `nlm embed-backfill` on any mismatch. That machinery shipped in Phase 1 and is the load-bearing guard for this feature.

**Out of slice-1 scope (documented, not built):** code-exemplar lane under bundled (CodeRankEmbed has no bundled equivalent; the lane is flag-gated off by default and its probe fails soft); classifier lane on a fresh install (indexing works unclassified; slice 3 owns the onboarding choice); Electron packaging (slice 2).

## Global Constraints

- This repo is PUBLIC. No internal hostnames, LAN IPs, home paths, client or unreleased-venture names in any committed text (localhost/127.0.0.1 fine).
- No em dashes in ANY added text. No literal NUL bytes. No narration comments (WHY-comments only).
- The ONLY permitted new dependency is `@huggingface/transformers@4.2.0` (exact pin, no caret). Nothing else enters package.json.
- Full gate after every task: `npm run typecheck` clean + `npm test` green. The real-model integration test is opt-in (`NLM_BUNDLED_EMBED_TEST=1`) so CI and normal `npm test` stay network-free and green.
- OUT OF FENCE (concurrent controller session + 2-day corpus reprocess): `src/core/classifier/prompt.ts`, `src/llm/naming.ts`, `src/core/workstream/**`, the user env file under `~/.nlm/`, `~/.nlm/reprocess.state`, corpus-scale jobs against `~/.nlm/canonical.sqlite`, daemon restart. This wave must not touch the live `~/.nlm` data dir at all: tests use temp dirs, and the opt-in integration test sets `NLM_BUNDLED_MODEL_DIR` to a temp path.
- Behavior fence: with `NLM_EMBED_PROVIDER` unset, `ollama`, or `openai`, every code path is byte-identical to main. The new branch activates only on the literal value `bundled`.
- If a task changes anything under `src/`, run `npm run build` and commit the refreshed plugin dist bundles in the same commit.
- Work in a worktree under `.worktrees/` on branch `feat/bundled-embedder`; one implementer in the tree at a time. Before merge to main: `git pull --rebase origin main`.
- Commit style: `feat(embedding): ...`, one commit per task.

---

### Task 1: BundledEmbedderClient behind the LLMClient port

**Files:**
- Create: `src/llm/bundled-embedder-client.ts`
- Test: `tests/unit/llm/bundled-embedder-client.test.ts`
- Modify: `package.json` (+ lockfile) for `@huggingface/transformers` pinned `4.2.0`

**Pinned interface (mirror `OpenAIEmbedderClient`):**

```ts
export const DEFAULT_BUNDLED_EMBED_MODEL = "nomic-embed-text-v1.5";

export interface BundledEmbedderOptions {
  readonly model?: string;        // HF repo id override, default resolves onnx-community/nomic-embed-text-v1.5
  readonly modelDir?: string;     // cache_dir, default join(homedir(), ".nlm", "models")
}

export class BundledEmbedderClient implements LLMClient {
  async embed(text: string, kind: EmbeddingKind): Promise<EmbedResult>;
  // classify() and rewriteForRecall() throw, same wording pattern as OpenAIEmbedderClient
}
```

**Steps:**
- [ ] TDD: unit tests first, with the transformers pipeline mocked at module boundary (vi.mock of `@huggingface/transformers`): applies `search_query: ` / `search_document: ` prefix by kind; truncates at MAX_EMBED_CHARS; returns L2-normalized Float32Array; reports `model` in EmbedResult; throws a clear error when the pipeline yields a non-768 dimension; lazy init (pipeline constructed once across calls); embed rejects cleanly when the import fails (no Ollama-style silent zeros).
- [ ] Implement with dynamic `import("@huggingface/transformers")` inside a memoized init; `pipeline("feature-extraction", <model repo>, { dtype: "q8", cache_dir: <modelDir> })`; call with `{ pooling: "mean", normalize: true }`; reuse `EMBED_PREFIXES`, `MAX_EMBED_CHARS`, `l2Normalize` imports from `./ollama-client.js` (the existing shared home for these constants).
- [ ] `npm install` the pinned dep; verify lockfile diff contains only the new packages.
- [ ] Gate: typecheck + full `npm test` green.
- [ ] Commit: `feat(embedding): bundled in-process embedder client (transformers.js, nomic-embed-text-v1.5)`

### Task 2: provider wiring (buildEmbedder, embedder-info, composition root)

**Files:**
- Modify: `src/llm/build-embedder.ts` (add `bundled` branch)
- Modify: `src/llm/embedder-info.ts` (provider `bundled` reports `NLM_EMBED_MODEL ?? DEFAULT_BUNDLED_EMBED_MODEL`)
- Modify: `src/cli/nlm.ts` `buildCodeEmbedder()` (a `bundled` provider must not throw: fall through to the existing Ollama code-embedder default with a WHY comment noting the code lane has no bundled engine yet and fails soft at probe)
- Tests: extend the existing unit tests beside each file (find them by grepping for `buildEmbedder(` and `resolveEmbedderInfo(` in tests/)

**Steps:**
- [ ] TDD: failing tests for the three surfaces, including the behavior fence (unset/ollama/openai select exactly what they select today).
- [ ] Implement; gate typecheck + full suite.
- [ ] `npm run build`; commit refreshed plugin bundles in the same commit.
- [ ] Commit: `feat(embedding): NLM_EMBED_PROVIDER=bundled selects the in-process embedder`

### Task 3: opt-in real-model integration test + fresh-install proof

**Files:**
- Create: `tests/integration/bundled-embedder.live.test.ts` (skipped unless `NLM_BUNDLED_EMBED_TEST=1`)

**Steps:**
- [ ] Test body: real BundledEmbedderClient with `NLM_BUNDLED_MODEL_DIR` in a temp dir when cheap, or the default cache when the controller pre-warmed it; embed a query and a document; assert dim 768, unit norm, and that two related texts cosine-score above two unrelated texts (sanity separation, not a benchmark).
- [ ] Fresh-install proof (controller-run, not CI): in a temp NLM home (`NLM_HOME`/equivalent temp data dir; confirm how tests point storage at a temp sqlite file and reuse that pattern) with `NLM_EMBED_PROVIDER=bundled` and NO Ollama/LM Studio reachable, ingest a fixture session through the real ingest path, then run semantic recall and get the session back. Record the transcript of this run in the ledger.
- [ ] Gate: full suite green WITHOUT the env flag (test skipped); green WITH the flag locally.
- [ ] Commit: `feat(embedding): opt-in live test for the bundled embedder`

### Task 4: docs, reviews, merge, board sync

- [ ] Docs: README (or wherever NLM_EMBED_PROVIDER values are documented; grep) gains the `bundled` row with the first-run download note and model dir override; `docs/embedding-model-swap.md` gains a line that switching provider to/from bundled is a lane change handled by the standard stale-lane flow.
- [ ] Per-task Sonnet review already done per task; Opus whole-branch final review (it is a src/-touching wave with a new dependency).
- [ ] Public-repo scrub over the whole unpushed range; NUL/em-dash/narration sweep.
- [ ] Merge to main (`git pull --rebase origin main` first), push, `gh run watch` to green.
- [ ] Board: update #363 notes (slice 1 shipped, slices 2 and 3 remain); CHANGELOG entry.
