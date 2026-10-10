/**
 * Resolve the live runtime transcript for "this session" — the backing for
 * `nlm transcript current`, which session-close's scanner normalizes through.
 *
 * Runtime-agnostic: it only uses TranscriptAdapter.discover/parseSession, so
 * every registered adapter works without format-specific code. An exact
 * runtime session ID wins; otherwise the newest session whose projectDir is the
 * requested cwd. No match is null, never a guess.
 */

import { resolve } from "node:path";
import type { SessionChunk, TranscriptAdapter } from "@ports/transcript-adapter.js";

export type CurrentSessionSelection = "exact-session-id" | "latest-in-project";

export interface CurrentSessionOptions {
  readonly adapters: ReadonlyArray<TranscriptAdapter>;
  readonly sessionId?: string;
  readonly cwd?: string;
  /** Discovery lookback for the newest-in-project path; ignored for an exact ID. */
  readonly since?: Date;
}

export interface CurrentSessionResult {
  readonly adapterName: string;
  readonly selection: CurrentSessionSelection;
  readonly session: SessionChunk;
}

type Env = Readonly<Record<string, string | undefined>>;

const RUNTIME_ALIASES: Readonly<Record<string, ReadonlyArray<string>>> = {
  "claude": ["claude-code"],
  "claude-code": ["claude-code"],
  "codex": ["codex"],
  "hermes": ["hermes-agent", "hermes"],
  "hermes-agent": ["hermes-agent"],
  "muse": ["muse"],
  "opencode": ["opencode"],
  "open-code": ["opencode"],
  "pi": ["pi"],
};

/** Each runtime's own session-ID env vars, in detection order. */
const SESSION_ENV: ReadonlyArray<readonly [string, ReadonlyArray<string>, ReadonlyArray<string>]> = [
  ["codex", ["CODEX_SESSION_ID", "CODEX_THREAD_ID"], ["codex"]],
  ["claude-code", ["CLAUDE_CODE_SESSION_ID", "CLAUDE_SESSION_ID"], ["claude-code"]],
  ["hermes-agent", ["HERMES_SESSION_ID"], ["hermes-agent", "hermes"]],
  ["pi", ["PI_SESSION_ID"], ["pi"]],
  ["opencode", ["OPENCODE_SESSION_ID"], ["opencode"]],
];

/** Adapter names for `--runtime`; `auto` reads the runtime from its session env
 *  var and is undefined (every adapter) when none is set. */
export function runtimeAdapterNames(runtime: string, env: Env): ReadonlyArray<string> | undefined {
  if (runtime === "auto") {
    for (const [, vars, names] of SESSION_ENV) {
      if (vars.some((v) => env[v])) return names;
    }
    return undefined;
  }
  const names = RUNTIME_ALIASES[runtime.toLowerCase()];
  if (!names) {
    throw new Error(
      `unsupported runtime ${runtime}; expected auto, ${Object.keys(RUNTIME_ALIASES).join(", ")}`,
    );
  }
  return names;
}

/** NXT_SESSION_ID, else the first session-ID env var belonging to one of `adapterNames`. */
export function sessionIdFromEnvironment(adapterNames: ReadonlyArray<string> | undefined, env: Env): string | undefined {
  if (env["NXT_SESSION_ID"]) return env["NXT_SESSION_ID"];
  const allowed = adapterNames ? new Set(adapterNames) : null;
  for (const [adapterName, vars] of SESSION_ENV) {
    if (allowed && !allowed.has(adapterName)) continue;
    const id = vars.map((v) => env[v]).find(Boolean);
    if (id) return id;
  }
  return undefined;
}

function endedAtMs(chunk: SessionChunk): number {
  const ended = Date.parse(chunk.endedAt);
  if (Number.isFinite(ended)) return ended;
  const started = Date.parse(chunk.startedAt);
  return Number.isFinite(started) ? started : 0;
}

export async function findCurrentSession(options: CurrentSessionOptions): Promise<CurrentSessionResult | null> {
  const candidates: { adapterName: string; session: SessionChunk }[] = [];
  await Promise.all(
    options.adapters.map(async (adapter) => {
      let refs: ReadonlyArray<string>;
      try {
        refs = await adapter.discover(options.sessionId || !options.since ? {} : { since: options.since });
      } catch {
        return; // one broken runtime store must not hide the others
      }
      const parsed = await Promise.all(refs.map((ref) => adapter.parseSession(ref).catch(() => null)));
      for (const session of parsed) {
        if (session) candidates.push({ adapterName: adapter.name, session });
      }
    }),
  );

  const newestFirst = (a: { session: SessionChunk }, b: { session: SessionChunk }): number =>
    endedAtMs(b.session) - endedAtMs(a.session);

  if (options.sessionId) {
    const id = options.sessionId;
    const exact = candidates
      .filter(({ session }) => session.runtimeSessionId === id || session.id === id)
      .sort(newestFirst)[0];
    return exact ? { ...exact, selection: "exact-session-id" } : null;
  }

  const cwd = options.cwd ? resolve(options.cwd) : null;
  const latest = candidates
    .filter(({ session }) => !cwd || (session.projectDir !== "" && resolve(session.projectDir) === cwd))
    .sort(newestFirst)[0];
  return latest ? { ...latest, selection: "latest-in-project" } : null;
}
