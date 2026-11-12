/**
 * Timestamped console wrapper for the long-running daemon (T1771).
 *
 * Why: launchd routes the daemon's stdout/stderr to ~/.nlm/daemon.log and
 * ~/.nlm/daemon.err, and none of the ~300 console.* lines the daemon writes
 * carry a timestamp — so "when did the fact-embed-sweep start failing" cannot
 * be answered from the log at all. Only the `start` command installs this;
 * one-shot CLI commands write to the operator's terminal, where a timestamp
 * prefix is just noise (and breaks `--json` consumers piping stdout).
 *
 * Every line becomes `<ISO-8601 UTC ms> <LEVEL> <original first line>` with
 * the remainder of a multi-line message left untouched — prefixing the first
 * line only keeps stack traces and pretty-printed JSON readable.
 *
 * Level classification is deliberately textual (the message text is the only
 * signal a console call carries):
 *   • console.warn  -> WARN
 *   • console.error lines containing error/fail/unreachable (case-insensitive)
 *     -> ERROR
 *   • lines starting with "warn" -> WARN
 *   • everything else -> INFO
 * The error check runs before the warn-prefix check, so "warning: host
 * unreachable" on the error stream reports ERROR, matching how an operator
 * greps the log.
 */

import { format } from "node:util";

export type WrappedConsoleMethod = "log" | "warn" | "error";
export type ConsoleLogLevel = "INFO" | "WARN" | "ERROR";

const ERROR_PATTERN = /error|fail|unreachable/i;
const WARN_PREFIX_PATTERN = /^warn/i;

/** Level for one rendered line, given the console method it came through. */
export function logLevelFor(method: WrappedConsoleMethod, firstLine: string): ConsoleLogLevel {
  if (method === "warn") return "WARN";
  if (method === "error" && ERROR_PATTERN.test(firstLine)) return "ERROR";
  if (WARN_PREFIX_PATTERN.test(firstLine.trimStart())) return "WARN";
  return "INFO";
}

/** Prefix one already-formatted message. Multi-line messages get the prefix
 *  on the first line only; the rest is byte-identical to the input. */
export function prefixLogLine(
  method: WrappedConsoleMethod,
  message: string,
  nowMs: number,
): string {
  const nl = message.indexOf("\n");
  const first = nl === -1 ? message : message.slice(0, nl);
  const rest = nl === -1 ? "" : message.slice(nl);
  return `${new Date(nowMs).toISOString()} ${logLevelFor(method, first)} ${first}${rest}`;
}

/** Minimal shape of the target so a test can pass a fake console. */
export interface ConsoleLike {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export interface TimestampedConsoleDeps {
  /** Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Defaults to the global console. */
  readonly target?: ConsoleLike;
}

/**
 * Wrap log/warn/error on `target` so each emitted line is timestamped.
 * Arguments are rendered with `util.format` first — identical bytes to what
 * the original method would have written, minus the prefix. Returns a
 * restore function (idempotent) so a test — or a future embedder — can undo
 * the wrap.
 */
export function installTimestampedConsole(deps: TimestampedConsoleDeps = {}): () => void {
  const target = deps.target ?? console;
  const now = deps.now ?? Date.now;
  const originals: Partial<Record<WrappedConsoleMethod, ConsoleLike[WrappedConsoleMethod]>> = {};
  for (const method of ["log", "warn", "error"] as const) {
    const original = target[method];
    originals[method] = original;
    const bound = original.bind(target);
    target[method] = (...args: unknown[]): void => {
      bound(prefixLogLine(method, format(...args), now()));
    };
  }
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    for (const method of ["log", "warn", "error"] as const) {
      const original = originals[method];
      if (original) target[method] = original;
    }
  };
}
