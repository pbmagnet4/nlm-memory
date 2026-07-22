import { describe, expect, it } from "vitest";
import { detectNvmPinnedVersion, nvmPinnedHookWarning } from "../../../src/install/claude-code.js";

const HOME = "/Users/edward";

describe("detectNvmPinnedVersion (#151)", () => {
  it("extracts the version from an nvm-managed execPath", () => {
    expect(detectNvmPinnedVersion(`${HOME}/.nvm/versions/node/v20.11.0/bin/node`, HOME)).toBe("v20.11.0");
  });

  it("returns null for a non-nvm execPath", () => {
    expect(detectNvmPinnedVersion("/usr/local/bin/node", HOME)).toBeNull();
    expect(detectNvmPinnedVersion("/opt/homebrew/bin/node", HOME)).toBeNull();
  });

  it("returns null for another user's nvm path", () => {
    expect(detectNvmPinnedVersion("/Users/someoneelse/.nvm/versions/node/v20.11.0/bin/node", HOME)).toBeNull();
  });
});

describe("nvmPinnedHookWarning (#151)", () => {
  it("formats the one-line warning when execPath is nvm-pinned", () => {
    expect(nvmPinnedHookWarning(`${HOME}/.nvm/versions/node/v22.3.1/bin/node`, HOME)).toBe(
      "hooks pin node v22.3.1; after an nvm upgrade re-run: nlm hook install",
    );
  });

  it("returns null when execPath is not nvm-pinned", () => {
    expect(nvmPinnedHookWarning("/usr/local/bin/node", HOME)).toBeNull();
  });
});
