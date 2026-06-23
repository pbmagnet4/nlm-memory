import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { makeOllamaGate, parseRecallGateMode } from "../../../src/hook/recall-gate.js";

describe("parseRecallGateMode", () => {
  it("returns undefined (gate off) by default", () => {
    expect(parseRecallGateMode({})).toBeUndefined();
  });

  it("returns undefined for an explicit off", () => {
    expect(parseRecallGateMode({ NLM_HOOK_RECALL_GATE: "off" })).toBeUndefined();
  });

  it("parses shadow", () => {
    expect(parseRecallGateMode({ NLM_HOOK_RECALL_GATE: "shadow" })).toBe("shadow");
  });

  it("parses live", () => {
    expect(parseRecallGateMode({ NLM_HOOK_RECALL_GATE: "live" })).toBe("live");
  });

  it("treats an unknown value as off", () => {
    expect(parseRecallGateMode({ NLM_HOOK_RECALL_GATE: "yes" })).toBeUndefined();
  });
});

describe("makeOllamaGate", () => {
  it("fails open to relevant when the gate model is too slow (timeout)", async () => {
    const server: Server = createServer(() => { /* never respond — simulate a cold/stuck model */ });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    try {
      const judge = makeOllamaGate(`http://127.0.0.1:${port}`, "qwen3.5:4b", 100);
      const v = await judge("prompt", "candidate");
      expect(v).toBe("relevant");
    } finally {
      server.close();
    }
  });
});
