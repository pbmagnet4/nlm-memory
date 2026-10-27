import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function releaseChannel(version, tagName) {
  if (!version || tagName !== `v${version}`) throw new Error("Release tag must match package.json version");
  const prerelease = version.split("+")[0].includes("-");
  return { npmTag: prerelease ? "next" : "latest", prerelease };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const channel = releaseChannel(version, process.env.GITHUB_REF_NAME);
  if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required");
  appendFileSync(process.env.GITHUB_OUTPUT, `npm_tag=${channel.npmTag}\nprerelease=${channel.prerelease}\n`);
}
