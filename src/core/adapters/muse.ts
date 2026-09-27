/**
 * Muse adapter.
 *
 * Reads ${XDG_DATA_HOME:-~/.local/share}/muse/sessions/YYYY/MM/DD/<session-id>/session.jsonl
 * files. Each line is an event-sourced record (`record_type: "event"`,
 * microsecond `recorded_at`); conversation turns come from a small set of
 * payloads and everything else is recall noise:
 *
 * Conversation extraction:
 * - `runtime.user_intent.accepted` (`surface: "main"`, `refill_blocks[].text`)
 *   -> [user] turn. The `run.started` event's `prompt` duplicates this text
 *   and is skipped. Non-main surfaces are steering, not conversation.
 * - `runtime.session` / `assistant_message_committed.text` -> [assistant] turn.
 *
 * Tool surface: `assistant_tool_calls_committed.tool_calls[].name` ->
 * `[tool_use: <name>]`; `tool_result_batch_committed.results[].text` ->
 * `[tool_result: <240-char preview>]`.
 *
 * Dropped: hooks, reasoning, reminders, approvals, task lifecycle,
 * resource samples, `model_user_messages` (a skill-body bundle), and the
 * `session.*.observed` bookkeeping events.
 *
 * Session id is the parent directory name; project dir comes from the
 * `runtime.session.metadata` record's `workspace_root`.
 *
 * Format reference: verified against a live 11k-line session on 2026-09-27.
 */

import { promises as fs } from "node:fs";
import { existsSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import type {
  DetectionResult,
  DiscoverOptions,
  SessionChunk,
  TranscriptAdapter,
} from "@ports/transcript-adapter.js";
import { durationMinutes, normalizeTimestamp, safeSessionId } from "./common.js";

const TOOL_RESULT_PREVIEW_CHARS = 240;

export interface MuseAdapterOptions {
  readonly sessionsPath?: string;
  readonly idleMinutes?: number;
}

interface Turn {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly timestamp: string;
}

function defaultSessionsPath(): string {
  const dataHome = process.env["XDG_DATA_HOME"] || join(homedir(), ".local", "share");
  return join(dataHome, "muse", "sessions");
}

/** Muse `recorded_at` is microseconds; common.normalizeTimestamp wants ms. */
function museTimestamp(ts: unknown): string {
  if (typeof ts === "number" && Number.isFinite(ts) && ts > 0) {
    return normalizeTimestamp(Math.trunc(ts / 1000));
  }
  return "";
}

export class MuseAdapter implements TranscriptAdapter {
  readonly name = "muse";
  readonly runtimeVersion = "muse/1.0";
  readonly transcriptKind = "muse-jsonl";

  private readonly sessionsPath: string;
  readonly idleMinutes: number;

  constructor(opts: MuseAdapterOptions = {}) {
    this.sessionsPath = opts.sessionsPath ?? defaultSessionsPath();
    this.idleMinutes = opts.idleMinutes ?? 15;
  }

  detect(): DetectionResult {
    const p = defaultSessionsPath();
    if (existsSync(p) && statSync(p).isDirectory()) {
      return { adapterName: this.name, enabled: true, path: p, hint: null };
    }
    return {
      adapterName: this.name,
      enabled: false,
      path: null,
      hint: "Muse not detected — no sessions directory. Sessions live under ${XDG_DATA_HOME:-~/.local/share}/muse/sessions/.",
    };
  }

  async discover(options: DiscoverOptions = {}): Promise<ReadonlyArray<string>> {
    if (!existsSync(this.sessionsPath)) return [];

    const found: { mtime: number; path: string }[] = [];
    const seen = new Set<string>();

    await this.walk(this.sessionsPath, seen, found, options.since);

    found.sort((a, b) => a.mtime - b.mtime);
    return found.map((f) => f.path);
  }

  async parseSession(path: string): Promise<SessionChunk | null> {
    const turns: Turn[] = [];
    let startedAt = "";
    let endedAt = "";
    let projectDir = "";
    let model = "";
    let totalBytes = 0;

    let raw: string;
    try {
      raw = await fs.readFile(path, "utf8");
    } catch {
      return null;
    }

    for (const line of raw.split("\n")) {
      totalBytes += Buffer.byteLength(line, "utf8") + 1;
      const trimmed = line.trim();
      if (!trimmed) continue;

      let row: Record<string, unknown>;
      try {
        row = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue;
      }

      const outerTs = museTimestamp(row["recorded_at"]);
      const payload =
        (row["payload"] as Record<string, unknown> | undefined) ?? {};
      const ptype = row["payload_type"];

      if (ptype === "runtime.session.metadata") {
        const rec = payload["record"] as Record<string, unknown> | undefined;
        if (rec) {
          if (!projectDir && typeof rec["workspace_root"] === "string") {
            projectDir = rec["workspace_root"];
          }
          if (!model && typeof rec["model"] === "string") {
            model = rec["model"];
          }
        }
        continue;
      }

      for (const turn of extractTurns(ptype, payload, outerTs)) {
        if (turn.timestamp && !startedAt) startedAt = turn.timestamp;
        if (turn.timestamp) endedAt = turn.timestamp;
        turns.push(turn);
      }
    }

    if (turns.length === 0) return null;

    const transcript = turns.map((t) => `[${t.role}] ${t.text}`).join("\n\n");
    const duration = durationMinutes(startedAt, endedAt);
    const label = provisionalLabel(turns);

    const runtimeSessionId = basename(dirname(path));
    const chunk: SessionChunk = {
      id: safeSessionId("muse", runtimeSessionId),
      runtime: this.runtimeVersion,
      runtimeSessionId,
      sourcePath: path,
      startedAt,
      endedAt,
      durationMin: duration,
      turnCount: turns.length,
      byteRange: [0, totalBytes],
      projectDir,
      gitBranch: "",
      text: transcript,
      label,
    };
    return model ? { ...chunk, model } : chunk;
  }

  private async walk(
    dir: string,
    seen: Set<string>,
    out: { mtime: number; path: string }[],
    since: Date | undefined,
  ): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        await this.walk(full, seen, out, since);
      } else if (ent.isFile() && ent.name === "session.jsonl") {
        if (seen.has(full)) continue;
        seen.add(full);
        let st;
        try {
          st = await fs.stat(full);
        } catch {
          continue;
        }
        if (st.size === 0) continue;
        if (since && st.mtime < since) continue;
        out.push({ mtime: st.mtimeMs, path: full });
      }
    }
  }
}

// ── event extraction ─────────────────────────────────────────────────────

function extractTurns(
  outerType: unknown,
  payload: Record<string, unknown>,
  outerTs: string,
): Turn[] {
  if (outerType === "runtime.user_intent.accepted") {
    if (payload["surface"] !== "main") return [];
    const blocks = payload["refill_blocks"];
    if (!Array.isArray(blocks)) return [];
    const text = blocks
      .filter(
        (b): b is Record<string, unknown> =>
          typeof b === "object" &&
          b !== null &&
          b["kind"] === "text" &&
          typeof b["text"] === "string",
      )
      .map((b) => b["text"] as string)
      .join("")
      .trim();
    if (!text) return [];
    return [{ role: "user", text, timestamp: outerTs }];
  }

  if (outerType === "runtime.session") {
    const event = payload["event"];
    if (typeof event !== "object" || event === null) return [];
    const ev = event as Record<string, unknown>;
    if (ev["kind"] === "assistant_message_committed") {
      const text = ev["text"];
      if (typeof text !== "string" || !text.trim()) return [];
      return [{ role: "assistant", text, timestamp: outerTs }];
    }
    if (ev["kind"] === "assistant_tool_calls_committed") {
      const calls = ev["calls"] ?? ev["tool_calls"];
      if (!Array.isArray(calls)) return [];
      return calls.map((c): Turn => {
        const name =
          typeof c === "object" && c !== null && typeof (c as Record<string, unknown>)["name"] === "string"
            ? ((c as Record<string, unknown>)["name"] as string)
            : "tool";
        return { role: "assistant", text: `[tool_use: ${name}]`, timestamp: outerTs };
      });
    }
    if (ev["kind"] === "tool_result_batch_committed") {
      const results = ev["results"];
      if (!Array.isArray(results)) return [];
      const turns: Turn[] = [];
      for (const res of results) {
        if (typeof res !== "object" || res === null) continue;
        const text = (res as Record<string, unknown>)["text"];
        if (typeof text !== "string" || !text.trim()) continue;
        const preview = text.slice(0, TOOL_RESULT_PREVIEW_CHARS);
        const ellipsis = text.length > TOOL_RESULT_PREVIEW_CHARS ? "…" : "";
        turns.push({
          role: "assistant",
          text: `[tool_result: ${preview}${ellipsis}]`,
          timestamp: outerTs,
        });
      }
      return turns;
    }
    return [];
  }

  return [];
}

function provisionalLabel(turns: ReadonlyArray<Turn>): string {
  for (const t of turns) {
    if (t.role !== "user") continue;
    const firstLine = t.text.split("\n", 1)[0]?.trim();
    if (firstLine) return firstLine.slice(0, 80);
  }
  return "Untitled session";
}
