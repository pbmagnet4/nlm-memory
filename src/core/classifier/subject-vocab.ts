/**
 * Subject vocabulary for the classifier's facts[].subject field.
 *
 * The wiki binds facts to vault pages by normalized subject, but free-form
 * classifier subjects miss the vault's canonical names ~97% of the time
 * (T1633). When an operator supplies a list of canonical subjects, the
 * classifier prompt can name them explicitly for the sessions they appear in.
 *
 * Source is a plain UTF-8 text file, one canonical subject per line (already
 * lowercase-hyphenated); `#` starts a comment, blank lines are ignored.
 * Path comes from NLM_SUBJECT_VOCAB_PATH. The persisted classifier settings
 * store is deliberately not consulted: it is a fixed three-column tuning row
 * (thinking/timeout/tokens) surfaced through the HTTP settings API, and a
 * host filesystem path does not belong in a daemon-wide row that may serve a
 * different machine than the one that wrote it. Env-only, like the classifier
 * provider vars in build-classifier.ts.
 *
 * Loading is lazy (first classify call), cached by mtime (a stats check per
 * call, a re-read only on change), and failure-tolerant: a missing or
 * unreadable file logs once per distinct error and behaves exactly like the
 * no-vocabulary case. The daemon must never crash over an operator config
 * file.
 */

import { readFileSync, statSync } from "node:fs";

export const SUBJECT_VOCAB_PATH_ENV = "NLM_SUBJECT_VOCAB_PATH";

/** Cap on how many subjects a single classify call may surface in the prompt. */
export const MAX_PROMPT_SUBJECTS = 50;

export interface SubjectVocab {
  /** Canonical subjects, in file order, deduplicated. */
  readonly subjects: readonly string[];
}

const EMPTY: SubjectVocab = { subjects: [] };

interface CacheEntry {
  mtimeMs: number;
  size: number;
  vocab: SubjectVocab;
}

const cache = new Map<string, CacheEntry>();
const warned = new Set<string>();

function warnOnce(key: string, msg: string, warn: (msg: string) => void): void {
  if (warned.has(key)) return;
  warned.add(key);
  warn(msg);
}

/**
 * Parse the vocabulary file format: one canonical subject per line, `#`
 * begins a comment (full-line or trailing), blank lines ignored. Entries
 * are lowercased defensively and deduplicated keeping first occurrence.
 */
export function parseSubjectVocab(text: string): SubjectVocab {
  const seen = new Set<string>();
  const subjects: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split("#", 1)[0]?.trim().toLowerCase() ?? "";
    if (line === "" || seen.has(line)) continue;
    seen.add(line);
    subjects.push(line);
  }
  return { subjects };
}

/**
 * Load the vocabulary at `path`. Cached by (mtimeMs, size): each call stats
 * the file and only re-reads when either changed, so an operator editing the
 * file while the daemon runs is picked up without a restart. Missing or
 * unreadable files yield the empty vocabulary and log once through `warn`
 * per distinct path+reason.
 */
export function loadSubjectVocab(path: string, warn: (msg: string) => void = () => {}): SubjectVocab {
  let stat;
  try {
    stat = statSync(path);
  } catch (e) {
    cache.delete(path);
    warnOnce(`stat:${path}`, `subject vocab: cannot read ${path} (${String(e)}); continuing without it`, warn);
    return EMPTY;
  }
  if (!stat.isFile()) {
    cache.delete(path);
    warnOnce(`notfile:${path}`, `subject vocab: ${path} is not a file; continuing without it`, warn);
    return EMPTY;
  }
  const hit = cache.get(path);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.vocab;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    cache.delete(path);
    warnOnce(`read:${path}`, `subject vocab: cannot read ${path} (${String(e)}); continuing without it`, warn);
    return EMPTY;
  }
  const vocab = parseSubjectVocab(text);
  cache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, vocab });
  return vocab;
}

/**
 * Resolve the configured vocabulary path and load it. Unset/blank env means
 * no vocabulary: no stat, no warn, empty result.
 */
export function loadConfiguredSubjectVocab(
  env: NodeJS.ProcessEnv = process.env,
  warn: (msg: string) => void = () => {},
): SubjectVocab {
  const raw = env[SUBJECT_VOCAB_PATH_ENV]?.trim();
  if (!raw) return EMPTY;
  return loadSubjectVocab(raw, warn);
}

/** Drop the cache and the once-log memory. Tests only. */
export function resetSubjectVocabCache(): void {
  cache.clear();
  warned.clear();
}
