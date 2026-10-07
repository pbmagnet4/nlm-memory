import { describe, expect, it } from "vitest";
import { packedFiles } from "../../../scripts/verify-codex-release.mjs";

const MANIFEST = JSON.stringify([
  {
    files: [{ path: "dist/cli/nlm.js" }, { path: "plugin/.codex-plugin/plugin.json" }],
  },
]);

describe("packedFiles", () => {
  it("reads a clean npm pack manifest", () => {
    expect(packedFiles(MANIFEST)).toEqual(
      new Set(["dist/cli/nlm.js", "plugin/.codex-plugin/plugin.json"]),
    );
  });

  it("skips prepare-lifecycle stdout ahead of the payload", () => {
    const polluted = [
      "vite v8.0.16 building client environment for production...",
      "[2K\rtransforming...",
      "rendering chunks... | computing gzip size...",
      "",
      MANIFEST,
      "",
    ].join("\n");
    expect(packedFiles(polluted)).toEqual(
      new Set(["dist/cli/nlm.js", "plugin/.codex-plugin/plugin.json"]),
    );
  });

  it("throws when no JSON payload is present", () => {
    expect(() => packedFiles("vite v8.0.16 building...\ntransforming...\n")).toThrow(
      /no JSON payload/,
    );
  });
});
