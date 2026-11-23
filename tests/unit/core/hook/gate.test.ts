import { describe, expect, it } from "vitest";
import { classifyPrompt, unwrapAgentEnvelope } from "../../../../src/core/hook/gate.js";

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

// Paseo wraps agent-to-agent traffic in an envelope whose routing attributes
// (source-agent-id, message-id) are UUIDs — pure noise for keyword and
// semantic recall. Unwrapping keeps the message, which is a real task.
describe("unwrapAgentEnvelope", () => {
  const envelope = (attrs: string, body: string) => `<paseo-system ${attrs}>${body}</paseo-system>`;
  const ROUTING =
    'version="1" kind="agent-message" source-agent-id="6ad88d89-e536-495b-b857-64fd180c7435" ' +
    'message-id="192b0630-32a8-43cd-a165-8d794f2c8851" source-agent-title="NxtOS"';

  it("returns the message of a closed agent-message envelope", () => {
    expect(unwrapAgentEnvelope(envelope(ROUTING, "run the gate on T2401"))).toEqual({
      kind: "agent-message",
      text: "run the gate on T2401",
    });
  });

  it("drops the closing tag and the whitespace around it", () => {
    expect(
      unwrapAgentEnvelope('<paseo-system kind="agent-message">\nfix the flaky test\n</paseo-system>\n'),
    ).toEqual({ kind: "agent-message", text: "fix the flaky test" });
  });

  it("keeps the rest of the string when the envelope is never closed", () => {
    expect(
      unwrapAgentEnvelope('<paseo-system kind="agent-message">\nsummarize the diff\nagent-response inline'),
    ).toEqual({ kind: "agent-message", text: "summarize the diff\nagent-response inline" });
  });

  it("reports a null kind when the opening tag carries no kind attribute", () => {
    expect(unwrapAgentEnvelope(envelope('source-agent-title="NxtOS"', "continue the audit"))).toEqual({
      kind: null,
      text: "continue the audit",
    });
  });

  it("reads the kind of an agent-notification", () => {
    expect(
      unwrapAgentEnvelope(envelope('kind="agent-notification" source-agent-id="6ad88d89"', "agent finished")),
    ).toEqual({ kind: "agent-notification", text: "agent finished" });
  });

  it("leaves a plain prompt untouched", () => {
    const plain = "  what did we decide about pgvector  ";
    expect(unwrapAgentEnvelope(plain)).toEqual({ kind: null, text: plain });
  });

  it("leaves a prompt that merely mentions the envelope mid-text untouched", () => {
    const mentions =
      'why does the hook choke on <paseo-system kind="agent-message"> wrappers in a transcript?';
    expect(unwrapAgentEnvelope(mentions)).toEqual({ kind: null, text: mentions });
  });

  it("leaves a different tag that merely starts with the envelope name untouched", () => {
    const other = "<paseo-systemic>explain the failure</paseo-systemic>";
    expect(unwrapAgentEnvelope(other)).toEqual({ kind: null, text: other });
  });

  it("classifies the unwrapped message, not the envelope", () => {
    // The routing attributes are what made notification fires look like content.
    expect(classifyPrompt(envelope(ROUTING, "ok"))).toBe("evaluate");
    expect(classifyPrompt(unwrapAgentEnvelope(envelope(ROUTING, "ok")).text)).toBe("skip");
  });
});
