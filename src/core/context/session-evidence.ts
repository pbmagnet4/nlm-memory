import type { Session } from "@shared/types.js";
import { MAX_CHUNK_CHARS, OVERLAP_CHARS } from "@core/embedding/chunk-body.js";
import { tokenSet } from "@core/recall/tokenize.js";

export interface Passage {
  readonly offset: number;
  readonly end: number;
  readonly text: string;
}

export function matchedPassages(session: Session, query: string, chunkIndex?: number, passageChars = 1_200): Passage[] {
  const body = session.body;
  if (!body) return [];
  const tokens = [...tokenSet(query)].filter((t) => t.length > 2);
  const positions = new Set<number>();
  const lower = body.toLowerCase();
  for (const token of tokens) {
    let pos = lower.indexOf(token);
    let count = 0;
    while (pos >= 0 && count++ < 40) {
      positions.add(Math.max(0, pos - 250));
      pos = lower.indexOf(token, pos + token.length);
    }
  }
  if (chunkIndex !== undefined) {
    const trimStart = body.length - body.trimStart().length;
    const header = [session.label, session.summary].map((s) => s.trim()).filter(Boolean).join(" ");
    const firstBudget = Math.max(1, MAX_CHUNK_CHARS - (header ? header.length + 1 : 0));
    const start = chunkIndex === 0 ? 0
      : Math.max(0, firstBudget - OVERLAP_CHARS) + (chunkIndex - 1) * (MAX_CHUNK_CHARS - OVERLAP_CHARS);
    const end = Math.min(body.length, trimStart + start + MAX_CHUNK_CHARS);
    for (let offset = trimStart + start; offset < end; offset += 950) positions.add(offset);
  }
  const candidates = [...positions].map((offset) => {
    const end = Math.min(body.length, offset + passageChars);
    const text = body.slice(offset, end);
    const words = tokenSet(text);
    const score = tokens.filter((t) => words.has(t)).length;
    return { offset, end, text, score };
  }).sort((a, b) => b.score - a.score || a.offset - b.offset);
  const selected: Passage[] = [];
  for (const { score, ...passage } of candidates) {
    if (!score && chunkIndex === undefined) continue;
    if (selected.some((p) => passage.offset < p.end && passage.end > p.offset)) continue;
    selected.push(passage);
    if (selected.length === 2) break;
  }
  return selected.sort((a, b) => a.offset - b.offset);
}

export function relevantStrings(values: readonly string[], query: string, limit = 4): string[] {
  const tokens = tokenSet(query);
  return [...new Set(values)].map((value, index) => ({ value, index,
    score: [...tokenSet(value)].filter((t) => tokens.has(t)).length,
  })).sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit).map((r) => r.value);
}

export function transcriptPage(body: string, offset: number, size: number) {
  // Keep surrogate pairs intact so concatenating pages reproduces the source.
  let end = Math.min(body.length, offset + size);
  const last = body.charCodeAt(end - 1);
  if (end < body.length && last >= 0xd800 && last <= 0xdbff) end--;
  return { offset, end, text: body.slice(offset, end), totalChars: body.length,
    nextOffset: end < body.length ? end : null };
}
