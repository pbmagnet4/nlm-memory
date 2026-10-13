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
