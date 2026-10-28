import { describe, expect, it } from "vitest";
import { activeProviderRow } from "../../../src/ui/lib/classifier-provider.js";
import type { ProviderRow } from "../../../src/ui/lib/registries.js";

function row(id: number, kind: ProviderRow["kind"], enabled = true): ProviderRow {
  return { id, kind, name: `p${id}`, baseUrl: null, apiKey: null, hasApiKey: true, defaultModel: null, enabled, createdAt: "", updatedAt: "" };
}

describe("activeProviderRow", () => {
  it("selects the openai row when openai is active, not the first enabled provider", () => {
    const rows = [row(1, "ollama"), row(2, "openai")];
    expect(activeProviderRow(rows, "openai")?.id).toBe(2);
  });

  it("matches an openai-compatible row for an active openai classifier", () => {
    expect(activeProviderRow([row(1, "ollama"), row(3, "openai-compatible")], "openai")?.id).toBe(3);
  });

  it("returns null instead of another provider when the registry has no row for the active one", () => {
    expect(activeProviderRow([row(1, "ollama"), row(4, "deepseek")], "openai")).toBeNull();
  });

  it("ignores a disabled row for the active provider", () => {
    expect(activeProviderRow([row(1, "ollama"), row(2, "openai", false)], "openai")).toBeNull();
  });
});
