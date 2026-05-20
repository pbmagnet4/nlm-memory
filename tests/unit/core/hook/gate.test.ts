import { describe, expect, it } from "vitest";
import { classifyPrompt } from "../../../../src/core/hook/gate.js";

describe("classifyPrompt", () => {
  it("classifies obvious generative openers as generative", () => {
    expect(classifyPrompt("draft a LinkedIn post about FTS5")).toBe("generative");
    expect(classifyPrompt("write the migration")).toBe("generative");
    expect(classifyPrompt("brainstorm names for the feature")).toBe("generative");
    expect(classifyPrompt("Create a test file")).toBe("generative");
  });

  it("classifies retrospective prompts as evaluate", () => {
    expect(classifyPrompt("what did we decide about pgvector")).toBe("evaluate");
    expect(classifyPrompt("have I worked with this client before")).toBe("evaluate");
    expect(classifyPrompt("why is the recall backend returning zero results")).toBe("evaluate");
  });

  it("strips leading filler before checking the opener", () => {
    expect(classifyPrompt("can you write a script")).toBe("generative");
    expect(classifyPrompt("please draft the email")).toBe("generative");
    expect(classifyPrompt("could you tell me what we decided")).toBe("evaluate");
  });

  it("defaults to evaluate for empty or ambiguous prompts", () => {
    expect(classifyPrompt("")).toBe("evaluate");
    expect(classifyPrompt("the FTS5 work")).toBe("evaluate");
    expect(classifyPrompt("fix the failing test")).toBe("evaluate");
  });
});
