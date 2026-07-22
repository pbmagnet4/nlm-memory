/**
 * Persisted last-known alert state — one JSON file so restarts don't
 * forget an in-progress drift/embedder episode and re-fire an alert
 * that already went out. Lives beside update-check.json in ~/.nlm/,
 * same cache-file shape/failure-mode convention as check.ts: unreadable
 * or corrupt just means "start from a clean slate," never a throw.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import {
  DEFAULT_DRIFT_ALERT_STATE,
  type DriftAlertState,
} from "./drift-transition.js";
import {
  DEFAULT_EMBEDDER_ALERT_STATE,
  type EmbedderAlertState,
} from "./embedder-transition.js";

export interface AlertState {
  readonly drift: DriftAlertState;
  readonly embedderCold: EmbedderAlertState;
}

export const DEFAULT_ALERT_STATE: AlertState = {
  drift: DEFAULT_DRIFT_ALERT_STATE,
  embedderCold: DEFAULT_EMBEDDER_ALERT_STATE,
};

export function defaultAlertStatePath(): string {
  return join(homedir(), ".nlm", "alert-state.json");
}

export async function readAlertState(path: string): Promise<AlertState> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<AlertState>;
    return {
      drift: { ...DEFAULT_DRIFT_ALERT_STATE, ...parsed.drift },
      embedderCold: { ...DEFAULT_EMBEDDER_ALERT_STATE, ...parsed.embedderCold },
    };
  } catch {
    // First run, corrupt file, or unreadable — start from a clean slate;
    // worst case is one extra false→true fire, never a crash.
    return DEFAULT_ALERT_STATE;
  }
}

export async function writeAlertState(path: string, state: AlertState): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(state, null, 2), "utf8");
  } catch {
    // Persist failure is non-fatal — the next check just re-evaluates
    // from a clean slate instead of remembering this transition.
  }
}
