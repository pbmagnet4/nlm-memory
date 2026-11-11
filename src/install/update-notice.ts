/**
 * The startup banner's one-line update notice (see the boot block in cli/nlm.ts).
 *
 * How you upgrade depends on how the code got there. An npm install is upgraded
 * with npm. A NxtOS install is versioned and atomic — the running build is
 * `<root>/versions/<v>/app/...` behind a `current` pointer, so `npm i -g
 * nlm-memory@latest` would install a second copy that nothing loads and the
 * actual upgrade goes through NxtOS. Detection is the same layout rule
 * `nlm connect pi` uses to float its extension entry.
 */
import { nxtOSInstallRoot } from "./pi.js";

export const NPM_UPDATE_HINT = "npm i -g nlm-memory@latest";
export const NXTOS_UPDATE_HINT = "NxtOS updates memory";

/**
 * Upgrade instruction for the install this bundle path belongs to. Takes the
 * bundle's own directory (never cwd or argv[0] — the notice is about the code
 * that is running, not the shell that invoked it).
 */
export function updateHintFor(bundleDir: string): string {
  return nxtOSInstallRoot(bundleDir) ? NXTOS_UPDATE_HINT : NPM_UPDATE_HINT;
}

/** One-line notice, two-space indented to line up with the other banner rows. */
export function formatUpdateNotice(current: string, latest: string, bundleDir: string): string {
  return `  update: ${current} → ${latest} available (${updateHintFor(bundleDir)})`;
}
