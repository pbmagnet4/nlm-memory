import { describe, expect, it } from "vitest";
import { NO_STORED_SETTINGS, resolveClassifierTuning } from "../../../../src/core/classifier/tuning.js";

describe("resolveClassifierTuning", () => {
  it("falls back to defaults with source 'default'", () => {
    const t = resolveClassifierTuning(NO_STORED_SETTINGS, {});
    expect(t.thinking).toEqual({ value: "off", source: "default" });
    expect(t.timeoutMs).toEqual({ value: 120_000, source: "default" });
    expect(t.maxTokens).toEqual({ value: 8192, source: "default" });
  });

  it("uses env when no setting is stored", () => {
    const t = resolveClassifierTuning(NO_STORED_SETTINGS, {
      NLM_CLASSIFIER_THINKING: "on", NLM_CLASSIFIER_TIMEOUT_MS: "240000", NLM_CLASSIFIER_MAX_TOKENS: "4096",
    });
    expect(t.thinking).toEqual({ value: "on", source: "env" });
    expect(t.timeoutMs).toEqual({ value: 240_000, source: "env" });
    expect(t.maxTokens).toEqual({ value: 4096, source: "env" });
  });

  it("a stored setting beats env, per field", () => {
    const t = resolveClassifierTuning(
      { thinking: "off", timeoutMs: null, maxTokens: 1024 },
      { NLM_CLASSIFIER_THINKING: "on", NLM_CLASSIFIER_TIMEOUT_MS: "240000", NLM_CLASSIFIER_MAX_TOKENS: "4096" },
    );
    expect(t.thinking).toEqual({ value: "off", source: "setting" });
    expect(t.timeoutMs).toEqual({ value: 240_000, source: "env" });
    expect(t.maxTokens).toEqual({ value: 1024, source: "setting" });
  });

  it("ignores invalid env values, uses the default and warns once per bad var", () => {
    const warnings: string[] = [];
    const t = resolveClassifierTuning(
      NO_STORED_SETTINGS,
      { NLM_CLASSIFIER_THINKING: "maybe", NLM_CLASSIFIER_TIMEOUT_MS: "5", NLM_CLASSIFIER_MAX_TOKENS: "lots" },
      (m) => warnings.push(m),
    );
    expect(t.thinking.source).toBe("default");
    expect(t.timeoutMs).toEqual({ value: 120_000, source: "default" });
    expect(t.maxTokens.source).toBe("default");
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toMatch(/NLM_CLASSIFIER_THINKING/);
  });

  it("an invalid env value does not shadow a stored setting or warn when unset", () => {
    const warnings: string[] = [];
    resolveClassifierTuning(NO_STORED_SETTINGS, {}, (m) => warnings.push(m));
    expect(warnings).toEqual([]);
  });
});
