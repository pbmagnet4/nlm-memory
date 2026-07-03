/**
 * Locked-query loader for the private-corpus bench harness.
 *
 * The query file lives OUTSIDE the repo tree and is never imported as a
 * module: it is read at runtime via NLM_PRIVATE_BENCH_QUERIES. This keeps
 * client names and real question text out of committed artifacts.
 *
 * The harness refuses (PrivateBenchRefusalError) on every case where the
 * file is absent, unreadable, malformed, unlocked, or empty. A refusal is
 * always the correct outcome when any precondition is unmet; the operator
 * must resolve it before running.
 */

import { existsSync, readFileSync } from "node:fs";

export interface LockedQuery {
  readonly id: string;
  readonly category: string;
  /** question is loaded and scored but never written to any report output. */
  readonly question: string;
  readonly goldSessionIds: ReadonlyArray<string>;
}

export interface LoadedQuerySet {
  readonly lockedAt: string;
  readonly queries: ReadonlyArray<LockedQuery>;
}

/** Thrown for every case where the harness must refuse to proceed. */
export class PrivateBenchRefusalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrivateBenchRefusalError";
  }
}

/**
 * Load and validate the locked query set.
 *
 * Reads NLM_PRIVATE_BENCH_QUERIES from the environment and validates the
 * file it points to. Returns the query set on success; throws
 * PrivateBenchRefusalError for every refusal case.
 */
export function loadLockedQueries(): LoadedQuerySet {
  const envPath = process.env["NLM_PRIVATE_BENCH_QUERIES"];
  if (!envPath) {
    throw new PrivateBenchRefusalError(
      "NLM_PRIVATE_BENCH_QUERIES is not set. " +
        "Export it to the absolute path of the locked query JSON file before running.",
    );
  }

  if (!existsSync(envPath)) {
    throw new PrivateBenchRefusalError(
      `Query file not found: ${envPath}`,
    );
  }

  let raw: string;
  try {
    raw = readFileSync(envPath, "utf8");
  } catch (e) {
    throw new PrivateBenchRefusalError(
      `Cannot read query file at ${envPath}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PrivateBenchRefusalError(
      `Query file at ${envPath} is not valid JSON.`,
    );
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as Record<string, unknown>)["locked"] !== true
  ) {
    throw new PrivateBenchRefusalError(
      `Query file at ${envPath}: "locked" must be exactly true. ` +
        "Lock the file before running the harness.",
    );
  }

  const file = parsed as Record<string, unknown>;
  const queries = file["queries"];
  if (!Array.isArray(queries) || queries.length === 0) {
    throw new PrivateBenchRefusalError(
      `Query file at ${envPath} has zero queries. Populate the query set before running.`,
    );
  }

  const lockedAt = typeof file["lockedAt"] === "string" ? file["lockedAt"] : "unknown";
  return { lockedAt, queries: queries as ReadonlyArray<LockedQuery> };
}
