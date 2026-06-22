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

  it("defaults to evaluate for ambiguous prompts with real content", () => {
    expect(classifyPrompt("the FTS5 work")).toBe("evaluate");
    expect(classifyPrompt("fix the failing test")).toBe("evaluate");
  });

  // Content gate (#352-adjacent precision fix): 41% of hook injections fired on
  // contentless prompts where there is no user query to serve — pure context
  // flooding. These must skip recall. Provably safe: any prompt that still
  // carries real user content after stripping harness boilerplate keeps firing.
  it("skips empty / whitespace / punctuation-only prompts", () => {
    expect(classifyPrompt("")).toBe("skip");
    expect(classifyPrompt("   ")).toBe("skip");
    expect(classifyPrompt("...")).toBe("skip");
  });

  it("skips bare acknowledgements (whole-prompt match only)", () => {
    expect(classifyPrompt("ok")).toBe("skip");
    expect(classifyPrompt("yes")).toBe("skip");
    expect(classifyPrompt("sure")).toBe("skip");
    expect(classifyPrompt("do it")).toBe("skip");
    expect(classifyPrompt("go ahead")).toBe("skip");
    expect(classifyPrompt("thanks!")).toBe("skip");
  });

  it("skips harness-injected event prompts (not user queries)", () => {
    expect(
      classifyPrompt("<ide_selection>The user selected lines 12 to 12 from /tmp/x.ts</ide_selection>"),
    ).toBe("skip");
    expect(
      classifyPrompt("<ide_opened_file>The user opened the file /tmp/x.ts in the IDE</ide_opened_file>"),
    ).toBe("skip");
    expect(
      classifyPrompt("<task-notification>\n<task-id>abc123</task-id>\n</task-notification>"),
    ).toBe("skip");
  });

  it("STILL fires when a real query follows a harness block (no recall regression)", () => {
    expect(
      classifyPrompt("<ide_selection>lines 1-5 of recall.ts</ide_selection>\n\nwhy does this return zero rows?"),
    ).toBe("evaluate");
    expect(
      classifyPrompt("<system-reminder>task tools available</system-reminder>\nwhat did we decide about pgvector"),
    ).toBe("evaluate");
    // A real query that merely starts with an ack word is not a bare ack.
    expect(classifyPrompt("ok so why is the backend returning zero results")).toBe("evaluate");
  });
});
