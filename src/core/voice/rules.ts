/**
 * Voice rules reader (design §B): loads `<voice>.yaml` files from a rules
 * directory, validates them against the shipped schema, and merges the
 * voice → channel → audience layers. Loading follows the file-config
 * precedent in src/core/scope/alias-map.ts, with an mtime fingerprint so a
 * file is re-parsed only when it changes. A bad file never fails recall: it
 * logs one WARN per file change and resolves to no rules.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { voiceRulesFileSchema, type VoiceRulesFile, type VoiceRulesOverrides } from "./rules-schema.js";

/** Voice names become file names; never path-join an unchecked one. */
const VOICE_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

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
  /** `${mtimeMs}:${size}` of the yaml file; the cache hit condition. */
  fingerprint: string;
  /** Parsed file, or null when the file is present but invalid. */
  file: VoiceRulesFile | null;
  /** git version of dir; computed with the file, not per call (design §B.3). */
  version: string | null;
};

// Keyed by absolute file path; tests use fresh mkdtemp dirs, so entries from
// different runs never collide.
const cache = new Map<string, CacheEntry>();

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

/** Reads and parses one rules file, cached by mtime+size. Null: file absent. */
function readFileEntry(
  dir: string,
  path: string,
  log?: (message: string) => void,
): CacheEntry | null {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    cache.delete(path); // missing (dir or file): no rules, no log
    return null;
  }
  const fingerprint = `${stat.mtimeMs}:${stat.size}`;
  const cached = cache.get(path);
  if (cached && cached.fingerprint === fingerprint) return cached;

  let entry: CacheEntry;
  try {
    const file = voiceRulesFileSchema.parse(parseYaml(readFileSync(path, "utf8")));
    entry = { fingerprint, file, version: rulesVersion(dir) };
  } catch (err) {
    log?.(`[voice] WARN ${path}: ${firstIssueMessage(err)}`);
    entry = { fingerprint, file: null, version: null };
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
  return readFileEntry(dir, path, log)?.file ?? null;
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

/**
 * `git -C <dir> rev-parse --short HEAD`, suffixed `-dirty` when tracked files
 * differ (untracked paths do not count), `unversioned` outside a git repo.
 */
export function rulesVersion(dir: string): string {
  const head = git(dir, ["rev-parse", "--short", "HEAD"])?.trim();
  if (!head) return "unversioned";
  const status = git(dir, ["status", "--porcelain"]);
  const dirty = status !== null && status.split("\n").some((l) => l.trim() !== "" && !l.startsWith("??"));
  return dirty ? `${head}-dirty` : head;
}

/**
 * One entry point for consumers: merged rules for a voice/channel/audience,
 * or null when there are none. Does not log; pass loadVoiceRules directly
 * when you want the invalid-file WARN.
 */
export function voiceRules(
  dir: string | undefined,
  voice: string,
  channel: string,
  audience?: string,
): VoiceRules | null {
  if (!dir) return null;
  const path = resolvePath(dir, voice);
  if (!path) return null;
  const entry = readFileEntry(dir, path);
  if (!entry || !entry.file) return null;
  return { ...resolveRules(entry.file, channel, audience), rulesVersion: entry.version ?? "unversioned" };
}
