import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendShadowLine, gatedClassification, makeClefIngestGate, parseIngestGateMode } from "@core/classifier/ingest-gate.js";
import { GATE_FEATURES } from "@core/classifier/gate-model.js";

const scoreAnswer = (score: number) => ({ type: "score", score, confidence: 0.9, probabilities: { "0": 0.1, "1": 0.2, "2": 0.3, "3": 0.4 }, legend: {} });
const noul = { type: "noul", noul: 0.5 };
const reply = (importance: number, kind = "trivial"): typeof fetch =>
  (async () => new Response(JSON.stringify({ answers: {
    importance: scoreAnswer(importance), extractable: scoreAnswer(1),
    kind: { type: "choice", choice: kind, confidence: 0.9, probabilities: { [kind]: 0.9 } },
    decision: noul, abandoned: noul, failure: noul, unfinished: noul, facts: noul, outcome: noul, delegated: noul,
  } }), { status: 200 })) as typeof fetch;

// P(stored) = sigmoid(10 * importance / 3 - 5): importance 0.8 gives 0.09, importance 2.4 gives 0.95.
const n = GATE_FEATURES.length;
const model = { mean: Array(n).fill(0), std: Array(n).fill(1), weights: [10, ...Array(n - 1).fill(0)], bias: -5, threshold: 0.5 };

describe("ingest gate", () => {
  it("parses the mode and defaults to off", () => {
    expect(parseIngestGateMode({})).toBe("off");
    expect(parseIngestGateMode({ NLM_INGEST_GATE: "shadow" })).toBe("shadow");
    expect(parseIngestGateMode({ NLM_INGEST_GATE: "live" })).toBe("live");
    expect(parseIngestGateMode({ NLM_INGEST_GATE: "yes" })).toBe("off");
  });

  it("skips when the fitted probability is below the model threshold", async () => {
    const low = await makeClefIngestGate({ baseUrl: "http://gw", apiKey: "k", model, fetchImpl: reply(0.8) })("hi");
    const high = await makeClefIngestGate({ baseUrl: "http://gw", apiKey: "k", model, fetchImpl: reply(2.4, "coding") })("work");
    expect(low).toMatchObject({ kind: "trivial", skip: true });
    expect(low.score).toBeCloseTo(1 / (1 + Math.exp(-(10 * 0.8 / 3 - 5))));
    expect(high).toMatchObject({ kind: "coding", skip: false });
    expect(high.score).toBeCloseTo(1 / (1 + Math.exp(-3)));
  });

  it("fails open on HTTP errors, bad replies and timeouts", async () => {
    const http = (async () => new Response("x", { status: 502 })) as typeof fetch;
    const bad = (async () => new Response(JSON.stringify({ answers: {} }), { status: 200 })) as typeof fetch;
    const hang = ((_u: string, init: RequestInit) => new Promise((_r, rej) =>
      init.signal?.addEventListener("abort", () => rej(new Error("aborted"))))) as typeof fetch;
    for (const fetchImpl of [http, bad, hang]) {
      const v = await makeClefIngestGate({ baseUrl: "http://gw", apiKey: "k", model, timeoutMs: 50, fetchImpl })("x");
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
    appendShadowLine(path, { id: "s1", runtime: "claude-code", chars: 10, threshold: 0.22, score: 0.1, kind: "trivial", skip: true, ms: 5 });
    const line = JSON.parse(readFileSync(path, "utf8").trim());
    expect(line).toMatchObject({ id: "s1", runtime: "claude-code", chars: 10, score: 0.1, kind: "trivial", wouldSkip: true, threshold: 0.22, ms: 5 });
    expect(typeof line.ts).toBe("string");
  });
});
