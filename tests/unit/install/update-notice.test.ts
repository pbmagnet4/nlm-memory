import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  NPM_UPDATE_HINT,
  NXTOS_UPDATE_HINT,
  formatUpdateNotice,
  updateHintFor,
} from "../../../src/install/update-notice.js";

/**
 * The notice is about the code that is running, so these build the two real
 * layouts and hand the helper the CLI's own bundle directory — for a published
 * install that is `<root>/versions/<v>/app/nlm/dist/cli` (package.json sits two
 * levels above `dist`, same as in a dev checkout).
 */
function nxtosBundleCliDir(): string {
  const root = mkdtempSync(join(tmpdir(), "nlm-nxtos-layout-"));
  const version = join(root, "versions", "0.22.1");
  const cliDir = join(version, "app", "nlm", "dist", "cli");
  mkdirSync(cliDir, { recursive: true });
  symlinkSync(version, join(root, "current"));
  return cliDir;
}

function plainCheckoutCliDir(withStrayVersions?: string): string {
  const root = mkdtempSync(join(tmpdir(), "nlm-checkout-"));
  const cliDir = withStrayVersions
    ? join(root, withStrayVersions, "app", "nlm", "dist", "cli")
    : join(root, "nlm-memory", "dist", "cli");
  mkdirSync(cliDir, { recursive: true });
  return cliDir;
}

describe("update install hint follows the running bundle's layout", () => {
  it("points at NxtOS for a versioned install with a current pointer", () => {
    const bundle = nxtosBundleCliDir();
    expect(updateHintFor(bundle)).toBe(NXTOS_UPDATE_HINT);
    expect(formatUpdateNotice("0.22.1", "0.23.0", bundle)).toBe(
      "  update: 0.22.1 → 0.23.0 available (NxtOS updates memory)",
    );
  });

  it("points at npm for a plain checkout or npm install", () => {
    const bundle = plainCheckoutCliDir();
    expect(updateHintFor(bundle)).toBe(NPM_UPDATE_HINT);
    expect(formatUpdateNotice("0.22.1", "0.23.0", bundle)).toBe(
      "  update: 0.22.1 → 0.23.0 available (npm i -g nlm-memory@latest)",
    );
  });

  it("stays on npm when a versions/ segment has no current pointer", () => {
    // e.g. ~/.nvm/versions/node/<v>/… and an interrupted NxtOS unpack.
    expect(updateHintFor(plainCheckoutCliDir("versions/0.22.1"))).toBe(NPM_UPDATE_HINT);
  });

  it("detects the realpath-resolved bundle Node actually hands the module", () => {
    // Node realpath-resolves `import.meta.url`, so the CLI's `__dirname` under
    // a NxtOS install is the pinned `versions/<v>/...` path even when the
    // process was launched through `current/...` (same fact hook-helpers'
    // isMainModule relies on). The floating spelling on its own is not a
    // versioned layout, which is why detection reads the bundle path rather
    // than argv[0].
    const root = mkdtempSync(join(tmpdir(), "nlm-nxtos-layout-"));
    const version = join(root, "versions", "0.22.1");
    mkdirSync(join(version, "app", "nlm", "dist", "cli"), { recursive: true });
    symlinkSync(version, join(root, "current"));
    const floating = join(root, "current", "app", "nlm", "dist", "cli");
    expect(updateHintFor(realpathSync(floating))).toBe(NXTOS_UPDATE_HINT);
    expect(updateHintFor(floating)).toBe(NPM_UPDATE_HINT);
  });
});
