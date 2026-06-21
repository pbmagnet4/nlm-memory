import { describe, expect, it, vi } from "vitest";
import { OllamaClient } from "../../../src/llm/ollama-client.js";
import { ClassifierSchemaError } from "../../../src/ports/llm-client.js";

// A valid classifier JSON payload (matches CLASSIFIER_JSON_SCHEMA required keys).
const VALID = JSON.stringify({
  label: "Test", summary: "s", entities: ["a"], decisions: [], open: [], confidence: 0.9,
});
function chatResponse(content: string) {
  return { ok: true, json: async () => ({ message: { content }, done_reason: "stop" }) } as unknown as Response;
}

describe("OllamaClient.classify retry", () => {
  it("retries on non-JSON content and succeeds on a later attempt", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(chatResponse("not json at all"))
      .mockResolvedValueOnce(chatResponse("also { broken"))
      .mockResolvedValueOnce(chatResponse(VALID));
    const client = new OllamaClient({ fetchImpl: fetchImpl as never, classifyAttempts: 3 });
    const out = await client.classify("transcript");
    expect(out.label).toBe("Test");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("throws ClassifierSchemaError after exhausting attempts", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(chatResponse("never valid json"));
    const client = new OllamaClient({ fetchImpl: fetchImpl as never, classifyAttempts: 3 });
    await expect(client.classify("transcript")).rejects.toBeInstanceOf(ClassifierSchemaError);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("does not retry a clean success (one call)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(chatResponse(VALID));
    const client = new OllamaClient({ fetchImpl: fetchImpl as never, classifyAttempts: 3 });
    await client.classify("transcript");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
