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
