import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { parse } from "yaml";
import { releaseChannel } from "../../../scripts/release-channel.mjs";

type Step = { name: string; run?: string; env?: Record<string, string> };
const workflow = parse(readFileSync(resolve(import.meta.dirname, "../../../.github/workflows/release.yml"), "utf8")) as { jobs: { publish: { steps: Step[] } } };
function step(name: string): Step {
  const found = workflow.jobs.publish.steps.find((s) => s.name === name);
  if (!found) throw new Error(`Missing release step: ${name}`);
  return found;
}
function capture(command: Step, binary: string, env: Record<string, string>): string[] {
  const directory = mkdtempSync(join(tmpdir(), "nlm-release-channel-"));
  try {
    const output = join(directory, "args.json");
    writeFileSync(join(directory, binary), `#!/usr/bin/env node\nconst fs = require('node:fs'); const args = process.argv.slice(2);\nif (args[0] === 'release' && args[1] === 'view') process.exit(1);\nfs.writeFileSync(process.env.ARGS_FILE, JSON.stringify(args));\n`, { mode: 0o755 });
    execFileSync("bash", ["-e", "-o", "pipefail", "-c", command.run!], { env: { ...process.env, ...env, PATH: `${directory}:${process.env["PATH"]}`, ARGS_FILE: output }, stdio: "pipe" });
    return JSON.parse(readFileSync(output, "utf8")) as string[];
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
describe("release workflow channel safety", () => {
  it("passes an explicit next tag to npm for a prerelease", () => {
    const command = step("Publish to npm with provenance");
    expect(capture(command, "npm", { NPM_DIST_TAG: "next" })).toEqual(expect.arrayContaining(["publish", "--tag", "next", "--provenance"]));
  });
  it("passes an explicit latest tag to npm for a stable release", () => {
    expect(capture(step("Publish to npm with provenance"), "npm", { NPM_DIST_TAG: "latest" })).toEqual(expect.arrayContaining(["--tag", "latest"]));
  });
  it("keeps stable GitHub releases eligible for latest", () => {
    const args = capture(step("Create GitHub Release"), "gh", { PRERELEASE: "false", GITHUB_REF_NAME: "v0.21.21" });
    expect(args).toContain("--latest");
    expect(args).not.toContain("--prerelease");
  });
  it("marks a GitHub prerelease as non-latest", () => {
    const args = capture(step("Create GitHub Release"), "gh", { PRERELEASE: "true", GITHUB_REF_NAME: "v0.21.21-rc.1" });
    expect(args).toEqual(expect.arrayContaining(["release", "create", "v0.21.21-rc.1", "--prerelease", "--latest=false"]));
  });
});

describe("release channel selection", () => {
  it.each(["0.21.21-rc.1", "0.22.0-beta.2", "0.21.21-property.1"])("keeps %s off stable", (version) => {
    expect(releaseChannel(version, `v${version}`)).toEqual({ npmTag: "next", prerelease: true });
  });
  it.each(["0.21.21", "0.21.21+build-with-hyphens"])("recognizes stable %s", (version) => {
    expect(releaseChannel(version, `v${version}`)).toEqual({ npmTag: "latest", prerelease: false });
  });
  it("refuses a mismatched or missing tag before publishing", () => {
    expect(() => releaseChannel("0.21.21-rc.1", "v0.21.20")).toThrow("must match");
    expect(() => releaseChannel("0.21.21-rc.1", undefined)).toThrow("must match");
  });
  it("wires the calculated channel into both publish commands", () => {
    expect(step("Publish to npm with provenance").env?.["NPM_DIST_TAG"]).toBe("${{ steps.channel.outputs.npm_tag }}");
    expect(step("Create GitHub Release").env?.["PRERELEASE"]).toBe("${{ steps.channel.outputs.prerelease }}");
  });
  it("writes channel metadata for the actual package version", () => {
    const directory = mkdtempSync(join(tmpdir(), "nlm-release-metadata-"));
    try {
      const output = join(directory, "output");
      const version = (JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../package.json"), "utf8")) as { version: string }).version;
      execFileSync(process.execPath, [resolve(import.meta.dirname, "../../../scripts/release-channel.mjs")], { env: { ...process.env, GITHUB_REF_NAME: `v${version}`, GITHUB_OUTPUT: output } });
      const channel = releaseChannel(version, `v${version}`);
      expect(readFileSync(output, "utf8")).toBe(`npm_tag=${channel.npmTag}\nprerelease=${channel.prerelease}\n`);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
