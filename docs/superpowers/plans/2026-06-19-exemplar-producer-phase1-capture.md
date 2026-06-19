# Code-exemplar producer — Phase 1 (capture) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When NLM ingests a coding session that produced a git commit, automatically capture the committed diff as a labeled code exemplar — zero install, populating the lane from normal sessions.

**Architecture:** Detection + extraction is a standalone engine. A new `drainSessionExemplars()` function (sibling to the scheduler's `drainSignals`) runs in the background ingest tick after a session is stored: it detects commit sha(s) in the session text, runs `git show` against the session's `projectDir`, composes a task-context from the classifier's summary/decisions, and inserts + embeds the exemplar. Best-effort and flag-gated; capture failure never affects session ingest.

**Tech Stack:** TypeScript (ESM, NodeNext), better-sqlite3, vitest, the existing `extractFromGitSha` git extractor, `OllamaCodeEmbedder` (CodeRankEmbed 768-dim), `SqliteCodeExemplarStore` / `PgCodeExemplarStore`.

## Global Constraints

- Capture is gated by `NLM_CODE_EXEMPLARS_ENABLED === "1"` (off by default), checked the same way `drainSignals` checks `NLM_SIGNALS_ENABLED`.
- Capture is **best-effort**: it must never throw out of the ingest tick or fail `insertSession`. Fail loud only inside `normalizeExemplar` (the existing boundary validator).
- Code embeddings are 768-dim (CodeRankEmbed); the embed call is fire-and-forget (an embed failure leaves the exemplar stored without a vector).
- Outcome for a committed diff is bootstrapped to `"pass"` (deterministic). LLM outcome-refinement is a later phase — not in this plan.
- Public repo: no home paths, tokens, or client names in code, comments, or commits.
- Each task is TDD: failing test → run (fail) → implement → run (pass) → commit. Run the full suite (`npx vitest run`) before the final commit of each task.
- Imports use the project's `@core/`, `@ports/`, `@shared/` path aliases (see existing files) and `.js` extensions on relative imports.

---

### Task 1: Decouple `extractFromGitSha` from `Signal`

Make the git extractor callable with a plain params object so the session producer (Task 3) can use it. Keep `extractExemplar(signal, opts)` working (the `/api/signal` capture path in `app.ts` calls it).

**Files:**
- Modify: `src/core/exemplars/extract-exemplar.ts`
- Test: `tests/unit/core/exemplars/extract-from-git-sha.test.ts` (create)

**Interfaces:**
- Produces: `extractFromGitSha(params: GitShaExtractParams): CodeExemplarInput | null` where
  ```ts
  export interface GitShaExtractParams {
    readonly repo: string;
    readonly sha: string;
    readonly installScope: string;
    readonly outcome: CodeExemplarOutcome;
    readonly model?: string;          // default "unknown"
    readonly signalId?: string | null;
    readonly sessionId?: string | null;
    readonly ts?: string;             // default now()
    readonly repoPath?: string;       // default = repo
    readonly taskContext?: string;    // override; default = funcname/file
  }
  ```
- Consumes: `normalizeExemplar` (src/core/exemplars/ingest-exemplar.ts), `CodeExemplarInput`/`CodeExemplarOutcome` (src/shared/types.ts).

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/core/exemplars/extract-from-git-sha.test.ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractFromGitSha } from "../../../../src/core/exemplars/extract-exemplar.js";

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

describe("extractFromGitSha (params object)", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "nlm-gitex-"));
    git(repo, "init", "-q");
    git(repo, "config", "user.email", "t@t.test");
    git(repo, "config", "user.name", "t");
    writeFileSync(join(repo, "add.ts"), "export function add(a: number, b: number) {\n  const total = a + b;\n  return total;\n}\n");
    git(repo, "add", "add.ts");
    git(repo, "commit", "-q", "-m", "add adder");
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("extracts the committed hunk for a sha", () => {
    const sha = git(repo, "rev-parse", "HEAD");
    const ex = extractFromGitSha({ repo, sha, installScope: "s", outcome: "pass" });
    expect(ex).not.toBeNull();
    expect(ex!.code).toContain("const total = a + b");
    expect(ex!.lang).toBe("ts");
    expect(ex!.outcome).toBe("pass");
    expect(ex!.gitSha).toBe(sha);
    expect(ex!.model).toBe("unknown");
  });

  it("uses a provided taskContext override", () => {
    const sha = git(repo, "rev-parse", "HEAD");
    const ex = extractFromGitSha({ repo, sha, installScope: "s", outcome: "pass", taskContext: "implement the adder" });
    expect(ex!.taskContext).toBe("implement the adder");
  });

  it("returns null for an unknown sha", () => {
    const ex = extractFromGitSha({ repo, sha: "deadbeef", installScope: "s", outcome: "pass" });
    expect(ex).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/core/exemplars/extract-from-git-sha.test.ts`
Expected: FAIL — `extractFromGitSha` currently takes `(signal, gitSha, opts)`, so the params-object call is a type error / wrong behavior.

- [ ] **Step 3: Refactor `extractFromGitSha` and adapt `extractExemplar`**

In `src/core/exemplars/extract-exemplar.ts`:

Add the params interface near the top (after the existing imports):
```ts
export interface GitShaExtractParams {
  readonly repo: string;
  readonly sha: string;
  readonly installScope: string;
  readonly outcome: CodeExemplarOutcome;
  readonly model?: string;
  readonly signalId?: string | null;
  readonly sessionId?: string | null;
  readonly ts?: string;
  readonly repoPath?: string;
  readonly taskContext?: string;
}
```
Add `CodeExemplarOutcome` to the existing type import from `@shared/types.js`.

Replace the body of `extractFromGitSha` so it takes `GitShaExtractParams` (keep the helper functions `parseHunks`, `parseFuncname`, `detectLang`, `extractAddedLines` unchanged):
```ts
export function extractFromGitSha(params: GitShaExtractParams): CodeExemplarInput | null {
  const repoPath = params.repoPath ?? params.repo;
  let diff: string;
  try {
    diff = execFileSync(
      "git",
      ["show", "--unified=3", "--diff-filter=AM", params.sha],
      { cwd: repoPath, encoding: "utf8", timeout: 10_000 },
    );
  } catch {
    return null;
  }

  const hunks = parseHunks(diff);
  if (hunks.length === 0) return null;

  let best: { file: string; hunkHeader: string; body: string } | undefined;
  let bestCount = 0;
  for (const h of hunks) {
    const added = extractAddedLines(h.body);
    const count = added.split("\n").filter((l) => l.trim()).length;
    if (count > bestCount) { bestCount = count; best = h; }
  }
  if (!best) return null;

  const code = extractAddedLines(best.body);
  const funcname = parseFuncname(best.hunkHeader);
  const taskContext = params.taskContext
    ?? (funcname ? `${funcname} (${best.file})` : `changes in ${best.file}`);

  try {
    return normalizeExemplar({
      installScope: params.installScope,
      signalId: params.signalId ?? null,
      sessionId: params.sessionId ?? null,
      repo: params.repo,
      model: params.model ?? "unknown",
      lang: detectLang(best.file),
      taskContext,
      code,
      outcome: params.outcome,
      gitSha: params.sha,
      survived: null,
      ...(params.ts ? { ts: params.ts } : {}),
    });
  } catch {
    return null;
  }
}
```

Update `extractExemplar` (the `Signal` entry point used by `app.ts`) to build params from the signal:
```ts
export function extractExemplar(
  signal: Signal,
  opts: ExtractOptions & { repoBasePath?: string },
): CodeExemplarInput | null {
  const gitSha =
    signal.detail && typeof signal.detail["git_sha"] === "string"
      ? (signal.detail["git_sha"] as string)
      : null;
  if (gitSha) {
    const repoPath = opts.repoBasePath ? `${opts.repoBasePath}/${signal.repo}` : signal.repo;
    const fromGit = extractFromGitSha({
      repo: signal.repo,
      sha: gitSha,
      installScope: opts.installScope,
      outcome: signal.outcome,
      model: signal.model,
      signalId: signal.id,
      sessionId: signal.sessionId,
      ts: signal.ts,
      repoPath,
    });
    if (fromGit) return fromGit;
  }
  return extractFromDetail(signal, opts);
}
```
Leave `extractFromDetail` unchanged.

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run tests/unit/core/exemplars/extract-from-git-sha.test.ts && npx tsc -p tsconfig.json --noEmit`
Expected: PASS, typecheck clean (confirms `app.ts`'s `extractExemplar` call still compiles).

- [ ] **Step 5: Commit**

```bash
git add src/core/exemplars/extract-exemplar.ts tests/unit/core/exemplars/extract-from-git-sha.test.ts
git commit -m "refactor(exemplars): extractFromGitSha takes a params object, decoupled from Signal"
```

---

### Task 2: `detectCommitShas` — find commit shas in a session transcript

**Files:**
- Create: `src/core/exemplars/detect-commits.ts`
- Test: `tests/unit/core/exemplars/detect-commits.test.ts`

**Interfaces:**
- Produces: `detectCommitShas(text: string): string[]` — deduped shas, in first-seen order.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/core/exemplars/detect-commits.test.ts
import { describe, expect, it } from "vitest";
import { detectCommitShas } from "../../../../src/core/exemplars/detect-commits.js";

describe("detectCommitShas", () => {
  it("finds the sha in standard git commit output", () => {
    expect(detectCommitShas("[main 1a2b3c4] add adder\n 1 file changed")).toEqual(["1a2b3c4"]);
  });
  it("handles root-commit and detached HEAD forms", () => {
    expect(detectCommitShas("[main (root-commit) abcdef1] init")).toEqual(["abcdef1"]);
    expect(detectCommitShas("[detached HEAD 0011223] wip")).toEqual(["0011223"]);
  });
  it("dedupes repeated shas, preserves order", () => {
    expect(detectCommitShas("[main 1a2b3c4] a\n...\n[main 1a2b3c4] a\n[main 9f8e7d6] b"))
      .toEqual(["1a2b3c4", "9f8e7d6"]);
  });
  it("returns empty for text with no commit output", () => {
    expect(detectCommitShas("just talking about code, no commits here")).toEqual([]);
  });
  it("does not match bracketed dates or short hex", () => {
    expect(detectCommitShas("see [2026-06-19] and [abc]")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/core/exemplars/detect-commits.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/core/exemplars/detect-commits.ts
/**
 * Detect git commit sha(s) in a session transcript, deterministically.
 *
 * Matches the `[branch sha] message` line git prints on commit (including
 * `(root-commit)` and `detached HEAD` variants). Requires >= 7 hex chars so
 * bracketed dates / short tokens don't false-positive. A false positive is
 * harmless downstream: `git show` on a non-sha just fails and is skipped.
 */
const COMMIT_LINE = /\[(?:[^\]]*\s)?([0-9a-f]{7,40})\]/g;

export function detectCommitShas(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(COMMIT_LINE)) {
    const sha = m[1];
    if (sha && !seen.has(sha)) {
      seen.add(sha);
      out.push(sha);
    }
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/core/exemplars/detect-commits.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/exemplars/detect-commits.ts tests/unit/core/exemplars/detect-commits.test.ts
git commit -m "feat(exemplars): detectCommitShas — find commit shas in a transcript"
```

---

### Task 3: `captureExemplarsFromSession` — the capture engine

Given a session's context, detect commits, extract each diff, and compose a task-context from the classifier's summary/decisions (the "beneficial choice").

**Files:**
- Create: `src/core/exemplars/capture-from-session.ts`
- Test: `tests/integration/exemplar-capture-from-session.test.ts`

**Interfaces:**
- Consumes: `detectCommitShas` (Task 2), `extractFromGitSha` (Task 1).
- Produces:
  ```ts
  export interface SessionExemplarContext {
    readonly sessionId: string;
    readonly projectDir: string;
    readonly text: string;
    readonly startedAt: string;
    readonly summary: string;
    readonly decisions: ReadonlyArray<string>;
    readonly installScope: string;
  }
  export function composeTaskContext(summary: string, decisions: ReadonlyArray<string>): string;
  export function captureExemplarsFromSession(ctx: SessionExemplarContext): CodeExemplarInput[];
  ```

- [ ] **Step 1: Write the failing test**

```ts
// tests/integration/exemplar-capture-from-session.test.ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  captureExemplarsFromSession,
  composeTaskContext,
} from "../../src/core/exemplars/capture-from-session.js";

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

describe("captureExemplarsFromSession", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "nlm-capsess-"));
    git(repo, "init", "-q");
    git(repo, "config", "user.email", "t@t.test");
    git(repo, "config", "user.name", "t");
    writeFileSync(join(repo, "throttle.ts"), "export function throttle(fn: () => void, ms: number) {\n  let last = 0;\n  return () => { const now = Date.now(); if (now - last > ms) { last = now; fn(); } };\n}\n");
    git(repo, "add", "throttle.ts");
    git(repo, "commit", "-q", "-m", "add throttle helper");
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("captures one exemplar from a session that committed", () => {
    const sha = git(repo, "rev-parse", "--short", "HEAD");
    const text = `assistant ran git commit\n[main ${sha}] add throttle helper\n 1 file changed`;
    const out = captureExemplarsFromSession({
      sessionId: "sess1",
      projectDir: repo,
      text,
      startedAt: "2026-06-19T12:00:00.000Z",
      summary: "Added a throttle utility",
      decisions: ["chose throttle over debounce for the scroll handler"],
      installScope: "install-test",
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.code).toContain("now - last > ms");
    expect(out[0]!.outcome).toBe("pass");
    expect(out[0]!.sessionId).toBe("sess1");
    expect(out[0]!.taskContext).toContain("throttle");
  });

  it("returns nothing when the session shows no commit", () => {
    const out = captureExemplarsFromSession({
      sessionId: "sess2", projectDir: repo, text: "no commit here",
      startedAt: "2026-06-19T12:00:00.000Z", summary: "chat", decisions: [], installScope: "install-test",
    });
    expect(out).toEqual([]);
  });

  it("returns nothing when projectDir is not a git repo", () => {
    const notRepo = mkdtempSync(join(tmpdir(), "nlm-norepo-"));
    try {
      const out = captureExemplarsFromSession({
        sessionId: "sess3", projectDir: notRepo, text: "[main 1a2b3c4] x",
        startedAt: "2026-06-19T12:00:00.000Z", summary: "s", decisions: [], installScope: "install-test",
      });
      expect(out).toEqual([]);
    } finally {
      rmSync(notRepo, { recursive: true, force: true });
    }
  });

  it("composeTaskContext prefers the decision when present", () => {
    expect(composeTaskContext("Added a throttle utility", ["chose throttle over debounce"]))
      .toBe("Added a throttle utility — chose throttle over debounce");
    expect(composeTaskContext("Just a summary", [])).toBe("Just a summary");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/exemplar-capture-from-session.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/core/exemplars/capture-from-session.ts
/**
 * Capture code exemplars from an ingested coding session.
 *
 * Detects the commit(s) the session produced, extracts each committed diff
 * deterministically (git show), and labels it with a task-context composed
 * from the classifier's summary + decisions — the "beneficial choice" the
 * code implemented. Outcome bootstraps to "pass" (committed = accepted);
 * LLM outcome-refinement is a later phase.
 *
 * Pure with respect to storage: returns CodeExemplarInput[] for the caller
 * (the scheduler) to insert + embed. Git failures yield fewer exemplars,
 * never wrong ones.
 */
import type { CodeExemplarInput } from "@shared/types.js";
import { detectCommitShas } from "./detect-commits.js";
import { extractFromGitSha } from "./extract-exemplar.js";

const TASK_CONTEXT_CAP = 280;

export interface SessionExemplarContext {
  readonly sessionId: string;
  readonly projectDir: string;
  readonly text: string;
  readonly startedAt: string;
  readonly summary: string;
  readonly decisions: ReadonlyArray<string>;
  readonly installScope: string;
}

export function composeTaskContext(summary: string, decisions: ReadonlyArray<string>): string {
  const base = summary.trim();
  const decision = decisions[0]?.trim();
  const text = decision ? `${base} — ${decision}` : base;
  return text.slice(0, TASK_CONTEXT_CAP);
}

export function captureExemplarsFromSession(ctx: SessionExemplarContext): CodeExemplarInput[] {
  if (!ctx.projectDir) return [];
  const taskContext = composeTaskContext(ctx.summary, ctx.decisions);
  const out: CodeExemplarInput[] = [];
  for (const sha of detectCommitShas(ctx.text)) {
    const exemplar = extractFromGitSha({
      repo: ctx.projectDir,
      sha,
      installScope: ctx.installScope,
      outcome: "pass",
      sessionId: ctx.sessionId,
      ts: ctx.startedAt,
      taskContext,
    });
    if (exemplar) out.push(exemplar);
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/integration/exemplar-capture-from-session.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/exemplars/capture-from-session.ts tests/integration/exemplar-capture-from-session.test.ts
git commit -m "feat(exemplars): captureExemplarsFromSession — commit-anchored capture engine"
```

---

### Task 4: `drainSessionExemplars` — store + embed, flag-gated, best-effort

The side-effecting wrapper the scheduler will call: runs the engine, inserts each exemplar, fire-and-forget embeds it. Gated by the flag; swallows all errors.

**Files:**
- Modify: `src/core/exemplars/capture-from-session.ts` (add the function)
- Test: `tests/integration/exemplar-capture-from-session.test.ts` (add a describe block)

**Interfaces:**
- Consumes: `captureExemplarsFromSession` (Task 3), `CodeExemplarStore` (@ports/code-exemplar-store.js), `CodeEmbedder` (@ports/code-embedder.js).
- Produces:
  ```ts
  export interface DrainExemplarDeps {
    readonly exemplarStore: CodeExemplarStore;
    readonly codeEmbedder?: CodeEmbedder | null;
    readonly logger?: (msg: string) => void;
  }
  export async function drainSessionExemplars(ctx: SessionExemplarContext, deps: DrainExemplarDeps): Promise<number>;
  ```
  Returns the count of newly-inserted exemplars. A no-op (returns 0) when `NLM_CODE_EXEMPLARS_ENABLED !== "1"`.

- [ ] **Step 1: Write the failing test**

Append to `tests/integration/exemplar-capture-from-session.test.ts`:
```ts
import type { CodeExemplarStore } from "../../src/ports/code-exemplar-store.js";
import type { CodeEmbedder } from "../../src/ports/code-embedder.js";
import type { CodeExemplarInput } from "../../src/shared/types.js";
import { drainSessionExemplars } from "../../src/core/exemplars/capture-from-session.js";

function fakeStore(): CodeExemplarStore & { inserted: CodeExemplarInput[]; embedded: string[] } {
  const inserted: CodeExemplarInput[] = [];
  const embedded: string[] = [];
  return {
    inserted, embedded,
    async insert(i) { inserted.push(i); return { id: `ex_${inserted.length}`, skipped: false }; },
    async insertMany(is) { for (const i of is) inserted.push(i); return is.length; },
    async upsertEmbedding(id) { embedded.push(id); },
    async searchByVector() { return []; },
    async getById() { return null; },
    async applyBucketCap() { return 0; },
    async pruneReverted() { return 0; },
    async pruneOlderThan() { return 0; },
  };
}
const fakeEmbedder: CodeEmbedder = { async embed() { return { vector: new Float32Array(768), dim: 768 }; } };

describe("drainSessionExemplars", () => {
  let repo: string;
  const prev = process.env["NLM_CODE_EXEMPLARS_ENABLED"];
  beforeEach(() => {
    delete process.env["NLM_CODE_EXEMPLARS_ENABLED"];
    repo = mkdtempSync(join(tmpdir(), "nlm-drain-"));
    git(repo, "init", "-q");
    git(repo, "config", "user.email", "t@t.test");
    git(repo, "config", "user.name", "t");
    writeFileSync(join(repo, "x.ts"), "export const x = () => {\n  const v = 1 + 1;\n  return v;\n};\n");
    git(repo, "add", "x.ts");
    git(repo, "commit", "-q", "-m", "add x");
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    if (prev === undefined) delete process.env["NLM_CODE_EXEMPLARS_ENABLED"];
    else process.env["NLM_CODE_EXEMPLARS_ENABLED"] = prev;
  });

  function ctx() {
    const sha = git(repo, "rev-parse", "--short", "HEAD");
    return {
      sessionId: "s", projectDir: repo, text: `[main ${sha}] add x`,
      startedAt: "2026-06-19T12:00:00.000Z", summary: "add x", decisions: [], installScope: "install-test",
    };
  }

  it("is a no-op when the flag is off", async () => {
    const store = fakeStore();
    const n = await drainSessionExemplars(ctx(), { exemplarStore: store, codeEmbedder: fakeEmbedder });
    expect(n).toBe(0);
    expect(store.inserted).toHaveLength(0);
  });

  it("inserts + embeds when the flag is on", async () => {
    process.env["NLM_CODE_EXEMPLARS_ENABLED"] = "1";
    const store = fakeStore();
    const n = await drainSessionExemplars(ctx(), { exemplarStore: store, codeEmbedder: fakeEmbedder });
    expect(n).toBe(1);
    expect(store.inserted).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 10)); // let the fire-and-forget embed resolve
    expect(store.embedded).toEqual(["ex_1"]);
  });

  it("never throws when the store fails", async () => {
    process.env["NLM_CODE_EXEMPLARS_ENABLED"] = "1";
    const broken: CodeExemplarStore = { ...fakeStore(), async insert() { throw new Error("db down"); } };
    await expect(drainSessionExemplars(ctx(), { exemplarStore: broken })).resolves.toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/exemplar-capture-from-session.test.ts`
Expected: FAIL — `drainSessionExemplars` not exported.

- [ ] **Step 3: Implement (append to `capture-from-session.ts`)**

```ts
import type { CodeExemplarStore } from "@ports/code-exemplar-store.js";
import type { CodeEmbedder } from "@ports/code-embedder.js";

export interface DrainExemplarDeps {
  readonly exemplarStore: CodeExemplarStore;
  readonly codeEmbedder?: CodeEmbedder | null;
  readonly logger?: (msg: string) => void;
}

export async function drainSessionExemplars(
  ctx: SessionExemplarContext,
  deps: DrainExemplarDeps,
): Promise<number> {
  if (process.env["NLM_CODE_EXEMPLARS_ENABLED"] !== "1") return 0;
  let count = 0;
  try {
    for (const input of captureExemplarsFromSession(ctx)) {
      const { id, skipped } = await deps.exemplarStore.insert(input);
      if (skipped) continue;
      count += 1;
      if (deps.codeEmbedder) {
        const embedder = deps.codeEmbedder;
        const store = deps.exemplarStore;
        void embedder
          .embed(input.taskContext + "\n" + input.code, "document")
          .then((r) => store.upsertEmbedding(id, r.vector))
          .catch(() => { /* degraded; exemplar stored without a vector */ });
      }
    }
  } catch (e) {
    deps.logger?.(`exemplar capture failed for ${ctx.sessionId}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return count;
}
```
Add the two `@ports/...` imports to the top of the file alongside the existing imports.

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run tests/integration/exemplar-capture-from-session.test.ts && npx tsc -p tsconfig.json --noEmit`
Expected: PASS (7 tests total), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/exemplars/capture-from-session.ts tests/integration/exemplar-capture-from-session.test.ts
git commit -m "feat(exemplars): drainSessionExemplars — flag-gated, best-effort store+embed"
```

---

### Task 5: Wire capture into the ingest scheduler

Add `exemplarStore` + `codeEmbedder` to `SchedulerOptions`, call `drainSessionExemplars` after a session is successfully stored, and pass the deps from the `start` action.

**Files:**
- Modify: `src/core/scheduler/scheduler.ts` (options + tick call)
- Modify: `src/cli/nlm.ts:341` (ScanScheduler construction)
- Test: `tests/integration/scheduler-exemplars.test.ts` (create)

**Interfaces:**
- Consumes: `drainSessionExemplars`, `SessionExemplarContext` (Task 3/4); `CodeExemplarStore`, `CodeEmbedder` ports.

- [ ] **Step 1: Write the failing test**

```ts
// tests/integration/scheduler-exemplars.test.ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../../src/core/storage/sqlite-storage.js";
import { ClaudeCodeAdapter } from "../../src/core/adapters/claude-code.js";
import { ScanScheduler } from "../../src/core/scheduler/scheduler.js";
import type { ClassifyResult, EmbedResult, LLMClient } from "../../src/ports/llm-client.js";
import type { CodeEmbedder } from "../../src/ports/code-embedder.js";
import Database from "better-sqlite3";

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

class StubClassifier implements LLMClient {
  async embed(): Promise<EmbedResult> { throw new Error("nu"); }
  async rewriteForRecall(): Promise<never> { throw new Error("nu"); }
  async classify(): Promise<ClassifyResult> {
    return { label: "L", summary: "Added throttle", entities: ["throttle"], decisions: ["chose throttle"], open: [], confidence: 0.9, facts: [] };
  }
}
class StubEmbedder implements LLMClient {
  async embed(): Promise<EmbedResult> { const v = new Float32Array(768); v[0] = 1; return { vector: v, model: "stub" }; }
  async rewriteForRecall(): Promise<never> { throw new Error("nu"); }
  async classify(): Promise<never> { throw new Error("nu"); }
}
const stubCodeEmbedder: CodeEmbedder = { async embed() { const v = new Float32Array(768); v[1] = 1; return { vector: v, dim: 768 }; } };

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

describe("scheduler captures exemplars from committed sessions", () => {
  let storage: SqliteStorage; let dbDir: string; let repo: string; let projects: string;
  const prev = process.env["NLM_CODE_EXEMPLARS_ENABLED"];
  beforeEach(async () => {
    process.env["NLM_CODE_EXEMPLARS_ENABLED"] = "1";
    dbDir = mkdtempSync(join(tmpdir(), "nlm-sched-ex-"));
    storage = SqliteStorage.create({ dbPath: join(dbDir, "canonical.sqlite"), migrationsDir: MIGRATIONS_DIR });
    await storage.init();

    // a real git repo that is the session's cwd
    repo = mkdtempSync(join(tmpdir(), "nlm-sched-repo-"));
    git(repo, "init", "-q"); git(repo, "config", "user.email", "t@t.test"); git(repo, "config", "user.name", "t");
    writeFileSync(join(repo, "t.ts"), "export const t = () => {\n  const v = 2 + 2;\n  return v;\n};\n");
    git(repo, "add", "t.ts"); git(repo, "commit", "-q", "-m", "add t");
    const sha = git(repo, "rev-parse", "--short", "HEAD");

    // a claude-code transcript whose cwd = the repo and whose text shows the commit
    projects = mkdtempSync(join(tmpdir(), "nlm-cc-"));
    const projDir = join(projects, "proj"); mkdirSync(projDir, { recursive: true });
    const jsonl =
      JSON.stringify({ type: "user", cwd: repo, timestamp: "2026-06-19T12:00:00.000Z", message: { role: "user", content: "add a throttle" } }) + "\n" +
      JSON.stringify({ type: "assistant", cwd: repo, timestamp: "2026-06-19T12:01:00.000Z", message: { role: "assistant", content: `committed: [main ${sha}] add t` } }) + "\n";
    const file = join(projDir, "session.jsonl");
    writeFileSync(file, jsonl);
    const old = (Date.now() - 60 * 60 * 1000) / 1000; // older than idleMinutes
    utimesSync(file, old, old);
  });
  afterEach(async () => {
    await storage.close();
    for (const d of [dbDir, repo, projects]) rmSync(d, { recursive: true, force: true });
    if (prev === undefined) delete process.env["NLM_CODE_EXEMPLARS_ENABLED"];
    else process.env["NLM_CODE_EXEMPLARS_ENABLED"] = prev;
  });

  it("lands an exemplar after a tick", async () => {
    const adapter = new ClaudeCodeAdapter({ rootDir: projects });
    const scheduler = new ScanScheduler({
      store: storage.sessions,
      adapters: [adapter],
      classifier: new StubClassifier(),
      embedder: new StubEmbedder(),
      installScope: "install-test",
      exemplarStore: storage.exemplars,
      codeEmbedder: stubCodeEmbedder,
      idleMinutes: 1,
      logger: () => {},
    });
    await scheduler.tick();

    // Assert directly on the table — deterministic, independent of the
    // fire-and-forget embed. A second readonly connection is safe.
    const db = new Database(join(dbDir, "canonical.sqlite"), { readonly: true });
    const row = db.prepare("SELECT COUNT(*) AS n, MIN(code) AS code FROM code_exemplars").get() as { n: number; code: string | null };
    db.close();
    expect(row.n).toBe(1);
    expect(row.code).toContain("2 + 2");
  });
});
```

> Note for the implementer: the *production* wiring in Steps 3–4 is exact and is the real deliverable. The test's transcript-fixture mechanics (the `ClaudeCodeAdapter` constructor option — `rootDir` is a guess — the minimal event shape, and the idle-mtime aging) must match the real adapter: open `src/core/adapters/claude-code.ts` and `tests/integration/scheduler.test.ts` and reproduce their exact constructor signature, event shape, and `ageFiles` approach. The only thing this test must prove is that **a committed session yields one `code_exemplars` row after a tick** — the assertion above does that without depending on the embed. If reproducing the claude-code fixture proves fiddly, substitute a minimal inline `TranscriptAdapter` (implement `detect`/`discover`/`parseSession` per `src/ports/transcript-adapter.ts`) whose `parseSession` returns a `SessionChunk` with `projectDir = repo` and `text` containing the commit line; that exercises the same tick path.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/scheduler-exemplars.test.ts`
Expected: FAIL — `SchedulerOptions` has no `exemplarStore`/`codeEmbedder`.

- [ ] **Step 3: Add options + the tick call in `scheduler.ts`**

In `SchedulerOptions` (after `signalStore`):
```ts
  /** Code-exemplar store. When set + NLM_CODE_EXEMPLARS_ENABLED=1, the tick
   *  captures exemplars from committed sessions after they are stored. */
  readonly exemplarStore?: CodeExemplarStore | null;
  /** Code embedder for exemplar vectors (CodeRankEmbed). */
  readonly codeEmbedder?: CodeEmbedder | null;
```
Add imports at the top of `scheduler.ts`:
```ts
import type { CodeExemplarStore } from "@ports/code-exemplar-store.js";
import type { CodeEmbedder } from "@ports/code-embedder.js";
import { drainSessionExemplars } from "@core/exemplars/capture-from-session.js";
```
In the tick, immediately after `inserted += 1;` (inside the `try`, after a successful `insertSession`), add:
```ts
          if (this.opts.exemplarStore && this.opts.installScope) {
            await drainSessionExemplars(
              {
                sessionId: chunk.id,
                projectDir: chunk.projectDir,
                text: chunk.text,
                startedAt: chunk.startedAt,
                summary: classification.summary,
                decisions: classification.decisions,
                installScope: this.opts.installScope,
              },
              { exemplarStore: this.opts.exemplarStore, codeEmbedder: this.opts.codeEmbedder, logger: this.opts.logger },
            );
          }
```
(`drainSessionExemplars` is itself best-effort, so it cannot throw into the tick.)

- [ ] **Step 4: Wire the deps in `nlm.ts`**

In `src/cli/nlm.ts`, the `new ScanScheduler({ ... })` call (~line 341), add two fields (the `start` action already destructures `storage` from `buildStack`, and `OllamaCodeEmbedder` + `ollamaUrl` are already imported):
```ts
          exemplarStore: storage.exemplars,
          codeEmbedder: new OllamaCodeEmbedder({ baseUrl: ollamaUrl() }),
```

- [ ] **Step 5: Run the test + full suite + typecheck**

Run: `npx vitest run tests/integration/scheduler-exemplars.test.ts && npx tsc -p tsconfig.json --noEmit && npx vitest run`
Expected: new test PASS; typecheck clean; full suite green (no regressions).

- [ ] **Step 6: Commit**

```bash
git add src/core/scheduler/scheduler.ts src/cli/nlm.ts tests/integration/scheduler-exemplars.test.ts
git commit -m "feat(exemplars): capture exemplars from committed sessions in the ingest tick"
```

---

## Manual verification (end of Phase 1)

With a local daemon (`NLM_CODE_EXEMPLARS_ENABLED=1` in `~/.nlm/.env`), after the next ingest tick processes a session in which an agent committed:

```bash
sqlite3 ~/.nlm/canonical.sqlite "SELECT COUNT(*) FROM code_exemplars;"   # > 0
nlm recall-code "<the task that session worked on>"                      # returns the committed code
```

Capture is automatic, zero-install, and populates retroactively as the scheduler re-scans existing transcripts.

## Self-review notes (coverage vs spec §A–C)

- §A (decouple `extractFromGitSha`) → Task 1.
- §B (ingest-trigger capture, `projectDir`, sha detection, best-effort, flag-gated) → Tasks 2, 4, 5.
- §C (task-context from summary/decisions; outcome bootstrap `pass`) → Task 3 (`composeTaskContext`). LLM outcome-refine is explicitly deferred (later phase) per the plan goal.
- §D (supersedence) and §E (passive recall) are **not** in this plan — they are Phases 3 and 2, each their own plan.
