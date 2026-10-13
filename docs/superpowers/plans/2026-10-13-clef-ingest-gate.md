# Clef Ingest Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Skip the generative classifier for sessions Clef scores as trivial, while still storing and indexing them, behind `NLM_INGEST_GATE=off|shadow|live`.

**Architecture:** Move the T533 Clef client and triage panel from `scripts/eval/lib` into `src` so the daemon and the evals share one calibrated panel. A new `src/core/classifier/ingest-gate.ts` scores a session once (importance 0 to 3) and fails open. `ScanScheduler` asks the gate before `classifyAdaptive`: in `shadow` it logs the verdict to `~/.nlm/clef-shadow.jsonl` (the format `scripts/eval/clef-shadow.ts --report` already reads) and classifies as usual; in `live` a below-threshold session is stored with its adapter label, empty extraction, and `clef-gate` provenance, and is not bound to a workstream.

**Tech Stack:** TypeScript (ESM, Node 22), Vitest, LiteLLM gateway pass-through `/clef/v1/systemone`, oMLX `clef-oQ4e`.

**Spec:** `docs/clef-decision-panel-findings.md` (H2 result: threshold 1.5 skips 28.5% of sessions, keeps 99.5% of decisions and 97.6% of facts on 799 sessions; 0 of 43 audited worthwhile sessions skipped) and `docs/superpowers/plans/2026-10-10-clef-decision-panel.md` (constraints).

## Global Constraints

- Public repo: no session text, IDs or names in committed files. No em dashes.
- Clef only through the gateway pass-through with `NLM_CLASSIFIER_BASE_URL` and `NLM_CLASSIFIER_API_KEY`; never print the key.
- Fail open: any Clef error, timeout or malformed reply classifies the session normally. The gate can never drop a session.
- Default is `off`: with `NLM_INGEST_GATE` unset, behaviour and tick output are byte-for-byte what they are today.
- The panel sent in production is exactly `triageQuestions()` from T533 with state `{ session: capState(text) }`, so the 1.5 threshold stays calibrated.
- Webhook ingest (`src/core/ingest/ingest-session.ts`) is out of scope and unchanged.
- Task tracking: nxttasks T642 (parent T639). Every commit carries a `Work-Id: T642` trailer.
- `npm run test:unit` and `npm run typecheck` pass before every commit.

## Review Focus

1. Clef down or slow during a tick: every session must still be classified, and the tick must not stall beyond the gate timeout (10 s) per session. Pinned in Task 2 and Task 3.
2. A gated session must still be findable: stored, body embedded, label set. Pinned in Task 3.
3. A gated session must not create or bind a workstream (that would spend a generative namer call and invent workstreams from trivia). Pinned in Task 3.
4. A gated session must not trip the 0.3 confidence floor or be counted as low confidence. Pinned in Task 3.
5. Shadow log lines must parse in `clef-shadow.ts --report` (same `LogLine` shape). Pinned in Task 2.

## File Structure

- Move `scripts/eval/lib/clef-client.ts` to `src/llm/clef-client.ts` (unchanged API).
- Move `capState` and `triageQuestions` from `scripts/eval/lib/clef-panels.ts` to `src/core/classifier/triage-panel.ts`; `clef-panels.ts` keeps its eval-only builders and imports these.
- Create `src/core/classifier/ingest-gate.ts`: `parseIngestGateMode`, `makeClefIngestGate`, `gatedClassification`, `appendShadowLine`.
- Modify `src/core/scheduler/scheduler.ts`: `ingestGate` option, gate step, `gatedSkips` in `TickReport`.
- Modify `src/cli/nlm.ts` (scheduler construction, around line 869): build the gate from env.
- Tests: `tests/unit/core/classifier/ingest-gate.test.ts`, `tests/unit/core/scheduler/ingest-gate.test.ts` (fixtures as in `signal-drain.test.ts`).
- Docs: README env table entry for `NLM_INGEST_GATE` and `NLM_INGEST_GATE_THRESHOLD`; CHANGELOG entry.

---

### Task 1: Move the client and panel into src

**Files:** `git mv scripts/eval/lib/clef-client.ts src/llm/clef-client.ts`; create `src/core/classifier/triage-panel.ts`; modify `scripts/eval/lib/clef-panels.ts`, every importer under `scripts/eval/` and `tests/unit/scripts/`.

**Interfaces:**
- Produces: `src/llm/clef-client.ts` exporting `askClef`, `askClefOrNull`, `ClefQuestion`, `ClefAnswer`, `ClefOptions` (unchanged); `src/core/classifier/triage-panel.ts` exporting `capState(text: string): string` and `triageQuestions(): Record<string, ClefQuestion>` (moved verbatim with `MAX_TRANSCRIPT_CHARS` / `truncateTranscript` imports).

- [ ] **Step 1:** `git mv` the client, cut `capState` and `triageQuestions` (and only what they need) into `triage-panel.ts`, re-export nothing from the old paths (no shims): update imports in `scripts/eval/*.ts`, `scripts/eval/lib/*.ts`, `tests/unit/scripts/*.ts` to `../../src/...` paths, and move the client test to `tests/unit/llm/clef-client.test.ts`.
- [ ] **Step 2:** Run `npm run test:unit && npm run typecheck`. Expected: PASS with the same test count as before the move.
- [ ] **Step 3:** Commit `refactor: move Clef client and triage panel into src` with `Work-Id: T642`.

### Task 2: The gate module

**Files:** create `src/core/classifier/ingest-gate.ts`, `tests/unit/core/classifier/ingest-gate.test.ts`.

**Interfaces:**
- Consumes: `askClef` (`src/llm/clef-client.ts`), `capState`, `triageQuestions` (Task 1), `ClassifyResult` (`src/ports/llm-client.ts`).
- Produces:
  - `type IngestGateMode = "off" | "shadow" | "live"`
  - `parseIngestGateMode(env?: NodeJS.ProcessEnv): IngestGateMode` (unset or unknown -> "off")
  - `interface GateVerdict { score: number | null; kind: string | null; skip: boolean; ms: number; error?: string }`
  - `makeClefIngestGate(o: { baseUrl: string; apiKey: string; threshold: number; timeoutMs?: number; fetchImpl?: typeof fetch }): (text: string) => Promise<GateVerdict>` (never throws; error -> `{ score: null, kind: null, skip: false, error }`)
  - `gatedClassification(label: string): ClassifyResult` (label kept, empty summary, entities, decisions, open, facts; confidence 1)
  - `appendShadowLine(path: string, line: { id: string; runtime: string; chars: number; threshold: number } & GateVerdict): void` (writes the `clef-shadow.ts` `LogLine` shape: `ts, id, runtime, chars, score, kind, wouldSkip, threshold, ms, error?`)

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendShadowLine, gatedClassification, makeClefIngestGate, parseIngestGateMode } from "@core/classifier/ingest-gate.js";

const reply = (score: number, kind = "trivial"): typeof fetch =>
  (async () => new Response(JSON.stringify({ answers: {
    importance: { type: "score", score, confidence: 0.9, probabilities: {}, legend: {} },
    kind: { type: "choice", choice: kind, confidence: 0.9, probabilities: {} },
  } }), { status: 200 })) as typeof fetch;

describe("ingest gate", () => {
  it("parses the mode and defaults to off", () => {
    expect(parseIngestGateMode({})).toBe("off");
    expect(parseIngestGateMode({ NLM_INGEST_GATE: "shadow" })).toBe("shadow");
    expect(parseIngestGateMode({ NLM_INGEST_GATE: "live" })).toBe("live");
    expect(parseIngestGateMode({ NLM_INGEST_GATE: "yes" })).toBe("off");
  });

  it("skips below the threshold and keeps at or above it", async () => {
    const low = makeClefIngestGate({ baseUrl: "http://gw", apiKey: "k", threshold: 1.5, fetchImpl: reply(0.8) });
    const high = makeClefIngestGate({ baseUrl: "http://gw", apiKey: "k", threshold: 1.5, fetchImpl: reply(1.5, "coding") });
    expect(await low("hi")).toMatchObject({ score: 0.8, kind: "trivial", skip: true });
    expect(await high("work")).toMatchObject({ score: 1.5, kind: "coding", skip: false });
  });

  it("fails open on HTTP errors, bad replies and timeouts", async () => {
    const http = (async () => new Response("x", { status: 502 })) as typeof fetch;
    const bad = (async () => new Response(JSON.stringify({ answers: {} }), { status: 200 })) as typeof fetch;
    const hang = ((_u: string, init: RequestInit) => new Promise((_r, rej) =>
      init.signal?.addEventListener("abort", () => rej(new Error("aborted"))))) as typeof fetch;
    for (const fetchImpl of [http, bad, hang]) {
      const v = await makeClefIngestGate({ baseUrl: "http://gw", apiKey: "k", threshold: 1.5, timeoutMs: 50, fetchImpl })("x");
      expect(v.skip).toBe(false);
      expect(v.score).toBeNull();
      expect(v.error).toBeTruthy();
    }
  });

  it("builds an empty classification that keeps the label", () => {
    const c = gatedClassification("quick lookup");
    expect(c).toEqual({ label: "quick lookup", summary: "", entities: [], decisions: [], open: [], confidence: 1, facts: [] });
  });

  it("writes shadow lines in the clef-shadow report shape", () => {
    const path = join(mkdtempSync(join(tmpdir(), "gate-")), "shadow.jsonl");
    appendShadowLine(path, { id: "s1", runtime: "claude-code", chars: 10, threshold: 1.5, score: 0.8, kind: "trivial", skip: true, ms: 5 });
    const line = JSON.parse(readFileSync(path, "utf8").trim());
    expect(line).toMatchObject({ id: "s1", runtime: "claude-code", chars: 10, score: 0.8, kind: "trivial", wouldSkip: true, threshold: 1.5, ms: 5 });
    expect(typeof line.ts).toBe("string");
  });
});
```

- [ ] **Step 2:** Run `npx vitest run tests/unit/core/classifier/ingest-gate.test.ts`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
import { appendFileSync } from "node:fs";
import { askClef } from "../../llm/clef-client.js";
import type { ClassifyResult } from "@ports/llm-client.js";
import { capState, triageQuestions } from "./triage-panel.js";

export type IngestGateMode = "off" | "shadow" | "live";

export interface GateVerdict {
  readonly score: number | null;
  readonly kind: string | null;
  readonly skip: boolean;
  readonly ms: number;
  readonly error?: string;
}

export function parseIngestGateMode(env: NodeJS.ProcessEnv = process.env): IngestGateMode {
  const v = env["NLM_INGEST_GATE"]?.trim();
  return v === "shadow" || v === "live" ? v : "off";
}

export function makeClefIngestGate(o: {
  baseUrl: string; apiKey: string; threshold: number; timeoutMs?: number; fetchImpl?: typeof fetch;
}): (text: string) => Promise<GateVerdict> {
  return async (text) => {
    const t0 = Date.now();
    try {
      const { answers } = await askClef({ session: capState(text) }, triageQuestions(), {
        baseUrl: o.baseUrl, apiKey: o.apiKey, timeoutMs: o.timeoutMs ?? 10_000,
        ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
      });
      const imp = answers["importance"];
      if (imp?.type !== "score") throw new Error("reply has no importance score");
      const kind = answers["kind"];
      return { score: imp.score, kind: kind?.type === "choice" ? kind.choice : null, skip: imp.score < o.threshold, ms: Date.now() - t0 };
    } catch (e) {
      return { score: null, kind: null, skip: false, ms: Date.now() - t0, error: (e instanceof Error ? e.message : String(e)).slice(0, 120) };
    }
  };
}

export function gatedClassification(label: string): ClassifyResult {
  return { label, summary: "", entities: [], decisions: [], open: [], confidence: 1, facts: [] };
}

export function appendShadowLine(
  path: string,
  l: { id: string; runtime: string; chars: number; threshold: number } & GateVerdict,
): void {
  appendFileSync(path, JSON.stringify({
    ts: new Date().toISOString(), id: l.id, runtime: l.runtime, chars: l.chars, score: l.score, kind: l.kind,
    wouldSkip: l.skip, threshold: l.threshold, ms: l.ms, ...(l.error ? { error: l.error } : {}),
  }) + "\n");
}
```

The score is carried in provenance (Task 3), not in the classification.

- [ ] **Step 4:** Run the test file, then `npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit `feat: Clef ingest gate module (off by default, fails open)` with `Work-Id: T642`.

### Task 3: Scheduler wiring

**Files:** modify `src/core/scheduler/scheduler.ts`, `src/cli/nlm.ts`; create `tests/unit/core/scheduler/ingest-gate.test.ts`, built on the fixtures in `tests/unit/core/scheduler/signal-drain.test.ts`.

**Interfaces:**
- Consumes: Task 2 exports.
- Produces: `SchedulerOptions.ingestGate?: { mode: IngestGateMode; threshold: number; judge: (text: string) => Promise<GateVerdict>; shadowLogPath: string } | null`; `TickReport.gatedSkips: number`.

Behaviour, inserted immediately before the `classifyAdaptive` call:
- `mode === "off"` or no gate: unchanged.
- Otherwise call `judge(chunk.text)` once. In `shadow`, `appendShadowLine` (catch and log any write error) and continue to `classifyAdaptive`. In `live` with `verdict.skip`, use `gatedClassification(chunk.label)`, increment `gatedSkips`, skip the confidence-floor check, stamp provenance `classifier: { provider: "clef-gate", model: "clef-oQ4e", confidence: score / 3 }`, store through the normal `insertSession` path (body embedded), and skip workstream binding for this session. In `live` without skip, continue to `classifyAdaptive`.
- Logging: one line per gated skip, `[scheduler] clef gate skipped classifier for <id> (importance <score>)`.

- [ ] **Step 1: Write failing scheduler tests** using the existing scheduler test fixtures (stub adapter yielding one chunk, stub classifier counting calls, in-memory SQLite store):
  1. live + judge returns `skip: true, score: 0.5`: classifier called 0 times; session stored with label = chunk label, summary "", no decisions; provenance provider `clef-gate`; `gatedSkips` 1; `skippedLowConfidence` 0; workstream store `create` and namer not called.
  2. live + judge returns `skip: false`: classifier called once, `gatedSkips` 0.
  3. live + judge returns an error verdict (`skip: false, score: null`): classifier called once.
  4. shadow + judge returns `skip: true`: classifier called once, one parseable line in the shadow log with `wouldSkip: true`.
  5. no `ingestGate`: judge never called, tick report has `gatedSkips: 0`.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement the scheduler change as specified above.
- [ ] **Step 4:** Wire `src/cli/nlm.ts` at the `new ScanScheduler({` call: when `parseIngestGateMode()` is not `off`, pass `ingestGate: { mode, threshold: Number(process.env.NLM_INGEST_GATE_THRESHOLD ?? "1.5"), judge: makeClefIngestGate({ baseUrl: process.env.NLM_CLASSIFIER_BASE_URL!, apiKey: process.env.NLM_CLASSIFIER_API_KEY!, threshold }), shadowLogPath: join(homedir(), ".nlm", "clef-shadow.jsonl") }`. If the base URL or key is missing while the gate is on, log `[scheduler] NLM_INGEST_GATE=<mode> ignored: NLM_CLASSIFIER_BASE_URL or NLM_CLASSIFIER_API_KEY unset` and pass `null` (fail open, loudly).
- [ ] **Step 5:** `npm run test:unit && npm run typecheck`. Expected: PASS.
- [ ] **Step 6:** Commit `feat: scheduler consults the Clef ingest gate (off, shadow, live)` with `Work-Id: T642`.

### Task 4: Docs, land, enable shadow

- [ ] **Step 1:** README env table: `NLM_INGEST_GATE` (`off` default, `shadow` logs to `~/.nlm/clef-shadow.jsonl`, `live` skips the classifier below the threshold) and `NLM_INGEST_GATE_THRESHOLD` (default 1.5, calibrated in `docs/clef-decision-panel-findings.md`). CHANGELOG entry (10-entry cap). Commit with `Work-Id: T642`.
- [ ] **Step 2:** Land: `~/.nxtos/bin/nxtgit land --cwd <worktree> --done`.
- [ ] **Step 3:** Enable shadow on this install: add `NLM_INGEST_GATE=shadow` to `~/.nlm/.env` (back up first to `.env.bak-20261013-ingest-gate`), restart with `launchctl kickstart -k gui/$(id -u)/io.whtnxt.nxtos.nlm`, confirm a `clef-shadow.jsonl` line appears for the next ingested session.
- [ ] **Step 4:** After about a week of shadow data, run `npx tsx scripts/eval/clef-shadow.ts --report` and decide on `live` with Edward. That decision is not part of this plan.
