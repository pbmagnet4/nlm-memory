import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

export const SEED = "T1142-v1";
export const WINDOW_RULE = { minProposals: 100, maxDays: 28 } as const;
export const LIVE_CANONICAL = join(homedir(), ".nlm", "canonical.sqlite");

export const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");
export const fileHash = (path: string): string => sha256(readFileSync(path));
export const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

/** Writes pretty JSON at mode 0600 (also when overwriting) and returns the hash of the bytes written. */
export function writePrivate(path: string, data: unknown): string {
  const text = JSON.stringify(data, null, 2);
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
  return sha256(text);
}
export function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

export const pathsIn = (dir: string) => ({
  manifest: join(dir, "manifest.json"), exclusions: join(dir, "exclusions.json"), catalog: join(dir, "catalog.json"),
  cards: join(dir, "cards.json"), predictions: join(dir, "predictions.json"), labels: join(dir, "labels.json"),
  sealed: join(dir, "labels.sealed"), l2: join(dir, "l2-labels.json"), scores: join(dir, "scores.json"),
  abstention: join(dir, "abstention-coverage.json"), limits: join(dir, "annotation-limits.json"),
});

/**
 * A snapshot is a read-only SQLite backup copy: not the live canonical store,
 * not owner-writable, no -wal/-shm beside it, and not in WAL mode (the state
 * `createSnapshot` leaves behind). Anything else could be the live database.
 */
export function assertSnapshot(path: string, live: string = LIVE_CANONICAL): void {
  if (!existsSync(path)) throw new Error(`not a snapshot: ${path} does not exist`);
  const real = realpathSync(path);
  if (existsSync(live) && real === realpathSync(live)) throw new Error("refusing the live canonical database: pass a snapshot copy made by npm run eval:snapshot");
  if (statSync(real).mode & 0o200) throw new Error(`not a snapshot: ${path} is writable (snapshots are mode 0444)`);
  for (const suffix of ["-wal", "-shm"]) if (existsSync(real + suffix)) throw new Error(`not a snapshot: ${path}${suffix} exists`);
  const db = new Database(real, { readonly: true, fileMustExist: true });
  try {
    const mode = String(db.pragma("journal_mode", { simple: true })).toLowerCase();
    if (mode === "wal") throw new Error(`not a snapshot: ${path} is in WAL mode`);
  } finally { db.close(); }
}

export interface Manifest {
  seed: string; freezeAt: string;
  windowCloseRule: { minProposals: number; maxDays: number; closesNoLaterThan: string };
  candidate: { sha: string; treeHash: string };
  catalogHash: string; strataHash: string; cardGeneratorHash: string; l2PromptHash: string;
  exclusions: { hash: string; sessions: number; sourceIdentities: number; assertionKeys: number };
  draw?: {
    drawnAt: string; cardsHash: string; predictionsHash: string; snapshot: { path: string; bytes: number };
    population: { eligibleFacts: number; factProposals: Record<string, number>; sessionsWithEntities: number; sessionRefs: Record<string, number> };
    flags: string[];
  };
}
