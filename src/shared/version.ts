/**
 * The running build's own version, for stamping into telemetry.
 *
 * Exists so a hook can report which build actually executed. "The hook fired"
 * and "the current hook fired" are different claims, and only the second one
 * catches an install pointing at a stale `dist/` — see
 * core/digest/hook-version-parity.ts.
 */

import pkg from "../../package.json" with { type: "json" };

export const NLM_VERSION: string = pkg.version;
