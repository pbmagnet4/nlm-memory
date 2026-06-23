import { readFileSync } from "node:fs";

/**
 * Extract message timestamps (epoch ms) from a transcript JSONL file, keeping
 * only those within [fromMs, toMs). Best-effort: a missing/unreadable file or
 * an unparseable line yields no timestamps rather than throwing. Accepts the
 * common timestamp fields across runtimes (claude-code/pi use `timestamp`).
 */
export function readTranscriptTimestamps(path: string, fromMs: number, toMs: number): number[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: number[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const tsRaw = obj["timestamp"] ?? obj["ts"] ?? obj["created_at"];
    if (typeof tsRaw !== "string") continue;
    const ms = Date.parse(tsRaw);
    if (!Number.isFinite(ms)) continue;
    if (ms >= fromMs && ms < toMs) out.push(ms);
  }
  out.sort((a, b) => a - b);
  return out;
}
