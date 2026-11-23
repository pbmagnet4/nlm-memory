/**
 * Voice rules reader (design §B): loads `<voice>.yaml` files from a rules
 * directory, validates them against the shipped schema, and merges the
 * voice → channel → audience layers. A file is read on every call (they are
 * small) but re-parsed only when its sha256 changes — an mtime/size
 * fingerprint can miss a same-length edit within one mtime tick and then
 * serve stale rules forever. rules_version shells out to git at most once
 * per 60 s per dir. A bad file never fails recall: it logs one WARN per
 * file change and resolves to no rules.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { voiceRulesFileSchema, type VoiceRulesFile, type VoiceRulesOverrides } from "./rules-schema.js";

/** Voice names become file names; never path-join an unchecked one. */
const VOICE_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

/** Rules files are small by design; anything bigger is refused unread. */
const MAX_RULES_BYTES = 256 * 1024;

/** rules_version resolution interval per dir; keeps git off the recall path. */
const GIT_VERSION_TTL_MS = 60_000;

export interface ResolvedRules {
  rules: string[];
  bannedPhrases: string[];
  /** Most specific defined max_chars wins; null when none is defined. */
  maxChars: number | null;
}

export interface VoiceRules extends ResolvedRules {
  rulesVersion: string;
}

type CacheEntry = {
  /** sha256 of the file bytes; for states we do not read, a meta fingerprint. */
  fingerprint: string;
  /** Parsed file, or null when the file is present but invalid. */
  file: VoiceRulesFile | null;
};

// Keyed by absolute file path; tests use fresh mkdtemp dirs, so entries from
// different runs never collide.
const cache = new Map<string, CacheEntry>();
const versionCache = new Map<string, { at: number; version: string }>();

function firstIssueMessage(err: unknown): string {
  if (err instanceof Error && "issues" in err) {
    const issues = (err as { issues: Array<{ path: PropertyKey[]; message: string }> }).issues;
    const first = issues[0];
    if (first) {
      const path = first.path.map(String).filter((p) => p.length > 0);
      return path.length > 0 ? `${path.join(".")}: ${first.message}` : first.message;
    }
  }
  return err instanceof Error ? err.message : String(err);
}

/** Reads and parses one rules file, re-parsing only when its bytes change. Null: file absent. */
function readFileEntry(path: string, log?: (message: string) => void): CacheEntry | null {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    cache.delete(path); // missing (dir or file): no rules, no log
    return null;
  }
  // Only a small regular file is readable: a FIFO would block readFileSync
  // forever, an oversized file is not a rules file. Warned once per change,
  // fingerprinted on stat since we never read it.
  if (!stat.isFile() || stat.size > MAX_RULES_BYTES) {
    const fingerprint = `meta:${stat.mtimeMs}:${stat.size}:${stat.isFile()}`;
    const cached = cache.get(path);
    if (cached && cached.fingerprint === fingerprint) return cached;
    log?.(
      `[voice] WARN ${path}: ${stat.isFile() ? `exceeds ${MAX_RULES_BYTES} bytes` : "not a regular file"}`,
    );
    const entry: CacheEntry = { fingerprint, file: null };
    cache.set(path, entry);
    return entry;
  }

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") {
      cache.delete(path); // vanished between stat and read
      return null;
    }
    log?.(`[voice] WARN ${path}: ${firstIssueMessage(err)}`);
    return null; // no content fingerprint to cache under; will warn again
  }
  const fingerprint = createHash("sha256").update(raw).digest("hex");
  const cached = cache.get(path);
  if (cached && cached.fingerprint === fingerprint) return cached;

  let entry: CacheEntry;
  try {
    entry = { fingerprint, file: voiceRulesFileSchema.parse(parseYaml(raw)) };
  } catch (err) {
    log?.(`[voice] WARN ${path}: ${firstIssueMessage(err)}`);
    entry = { fingerprint, file: null };
  }
  cache.set(path, entry);
  return entry;
}

function resolvePath(dir: string, voice: string): string | null {
  if (!VOICE_NAME_RE.test(voice)) return null;
  return join(dir, `${voice}.yaml`);
}

/**
 * Loads `<dir>/<voice>.yaml`. No rules (null) — without logging — when dir is
 * unset or missing, the voice name is unsafe, or the file is absent; invalid
 * files log one WARN per file change and also resolve to null.
 */
export function loadVoiceRules(
  dir: string | undefined,
  voice: string,
  log?: (message: string) => void,
): VoiceRulesFile | null {
  if (!dir) return null;
  const path = resolvePath(dir, voice);
  if (!path) return null;
  return readFileEntry(path, log)?.file ?? null;
}

function pick(
  overrides: Record<string, VoiceRulesOverrides> | undefined,
  key: string,
): VoiceRulesOverrides | undefined {
  // hasOwn, not `["k"] in obj`: channel names like "constructor" must not
  // reach Object.prototype.
  return overrides && Object.hasOwn(overrides, key) ? overrides[key] : undefined;
}

/**
 * Merges one loaded file for a channel (and optional audience): rules lists
 * concatenate voice → channel → audience, banned phrases concatenate and
 * dedupe preserving order, max_chars takes the most specific defined value.
 * An unknown channel or audience contributes nothing (design §B.2).
 */
export function resolveRules(
  file: VoiceRulesFile,
  channel: string,
  audience?: string,
): ResolvedRules {
  const ch = pick(file.channels, channel);
  const aud = audience === undefined ? undefined : pick(file.audiences, audience);
  const layers = [file as VoiceRulesOverrides, ch, aud].filter((l) => l !== undefined);

  const rules = layers.flatMap((l) => l.rules ?? []);
  const bannedPhrases: string[] = [];
  const seen = new Set<string>();
  for (const phrase of layers.flatMap((l) => l.banned_phrases ?? [])) {
    if (!seen.has(phrase)) {
      seen.add(phrase);
      bannedPhrases.push(phrase);
    }
  }
  let maxChars: number | null = null;
  for (const l of layers) if (l.max_chars !== undefined) maxChars = l.max_chars;

  return { rules, bannedPhrases, maxChars };
}

function git(dir: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

function computeVersion(dir: string): string {
  const head = git(dir, ["rev-parse", "--short", "HEAD"])?.trim();
  if (!head) return "unversioned";
  const status = git(dir, ["status", "--porcelain"]);
  const dirty = status !== null && status.split("\n").some((l) => l.trim() !== "" && !l.startsWith("??"));
  return dirty ? `${head}-dirty` : head;
}

/**
 * `git -C <dir> rev-parse --short HEAD`, suffixed `-dirty` when tracked files
 * differ (untracked paths do not count), `unversioned` outside a git repo.
 * Cached per dir for `ttlMs` (default 60 s) so recall never shells out to
 * git per call; `now` is injectable for tests.
 */
export function rulesVersion(
  dir: string,
  ttlMs: number = GIT_VERSION_TTL_MS,
  now: () => number = Date.now,
): string {
  const at = now();
  const cached = versionCache.get(dir);
  if (cached && at - cached.at < Math.max(ttlMs, 0)) return cached.version;
  const version = computeVersion(dir);
  versionCache.set(dir, { at, version });
  return version;
}

/**
 * One entry point for consumers: merged rules for a voice/channel/audience,
 * or null when there are none. `log` receives the invalid-file WARN (one per
 * file change).
 */
export function voiceRules(
  dir: string | undefined,
  voice: string,
  channel: string,
  audience?: string,
  log?: (message: string) => void,
): VoiceRules | null {
  if (!dir) return null;
  const path = resolvePath(dir, voice);
  if (!path) return null;
  const entry = readFileEntry(path, log);
  if (!entry || !entry.file) return null;
  return { ...resolveRules(entry.file, channel, audience), rulesVersion: rulesVersion(dir) };
}
