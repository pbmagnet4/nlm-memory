/**
 * NousResearch Hermes Agent adapter.
 *
 * Reads the Hermes Agent SQLite state database at:
 *   ~/.hermes/state.db  (customizable via HERMES_HOME)
 *
 * Schema (schema version 11):
 *   sessions — id, title, source, started_at (Unix float), ended_at (Unix float)
 *   messages — id, session_id, role, content, tool_calls (JSON), tool_name, timestamp (Unix float)
 *
 * Roles extracted: user, assistant (with optional tool_calls), tool (result).
 * Roles skipped: system.
 *
 * Tool calls in assistant messages are summarized as [tool_use: <name>].
 * Tool result messages are summarized as [tool_result: <name>: <preview>].
 *
 * This adapter is distinct from HermesAdapter (src/core/adapters/hermes.ts),
 * which reads Whtnxt Hermes WebUI session JSON files from ~/.hermes/sessions/.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type {
  DetectionResult,
  DiscoverOptions,
  SessionChunk,
  TranscriptAdapter,
} from "@ports/transcript-adapter.js";
import { durationMinutes, normalizeTimestamp, safeSessionId } from "./common.js";

const TOOL_RESULT_PREVIEW_CHARS = 240;

export interface HermesAgentAdapterOptions {
  readonly dbPath?: string;
}

interface Turn {
  readonly role: "user" | "assistant" | "tool";
  readonly text: string;
  readonly timestamp: number;
}

interface SessionRow {
  readonly id: string;
  readonly title: string | null;
  readonly started_at: number;
  readonly ended_at: number | null;
}

interface MessageRow {
  readonly id: number;
  readonly role: string;
  readonly content: string | null;
  readonly tool_calls: string | null;
  readonly tool_name: string | null;
  readonly timestamp: number;
}

interface ToolCall {
  readonly function?: {
    readonly name?: string;
  };
}

export function defaultDbPath(): string {
  if (process.env["NLM_HERMES_AGENT_DB_PATH"]) return process.env["NLM_HERMES_AGENT_DB_PATH"];
  const hermesHome = process.env["HERMES_HOME"] ?? join(homedir(), ".hermes");
  return join(hermesHome, "state.db");
}

function readGitBranch(directory: string): string {
  try {
    const head = readFileSync(join(directory, ".git", "HEAD"), "utf8").trim();
    const match = /^ref: refs\/heads\/(.+)$/.exec(head);
    return match ? (match[1] ?? "") : "";
  } catch {
    return "";
  }
}

function extractTurns(messages: MessageRow[]): Turn[] {
  const turns: Turn[] = [];
  for (const msg of messages) {
    if (msg.role === "system") continue;
    if (msg.role !== "user" && msg.role !== "assistant" && msg.role !== "tool") continue;

    const segments: string[] = [];

    if (msg.role === "tool") {
      const name = msg.tool_name ?? "tool";
      const raw = msg.content ?? "";
      const preview = raw.slice(0, TOOL_RESULT_PREVIEW_CHARS);
      const ellipsis = raw.length > TOOL_RESULT_PREVIEW_CHARS ? "…" : "";
      if (raw) segments.push(`[tool_result: ${name}: ${preview}${ellipsis}]`);
      else segments.push(`[tool_result: ${name}]`);
    } else {
      if (msg.content) segments.push(msg.content);

      if (msg.tool_calls) {
        let calls: ToolCall[];
        try {
          calls = JSON.parse(msg.tool_calls) as ToolCall[];
        } catch {
          calls = [];
        }
        for (const tc of calls) {
          const name = tc.function?.name ?? "tool";
          segments.push(`[tool_use: ${name}]`);
        }
      }
    }

    const text = segments.join("\n").trim();
    if (!text) continue;

    turns.push({
      role: msg.role as Turn["role"],
      text,
      timestamp: msg.timestamp,
    });
  }
  return turns;
}

function provisionalLabel(turns: ReadonlyArray<Turn>): string {
  for (const t of turns) {
    if (t.role !== "user") continue;
    const first = t.text.split("\n", 1)[0]?.trim();
    if (first) return first.slice(0, 80);
  }
  return "Untitled session";
}

export class HermesAgentAdapter implements TranscriptAdapter {
  readonly name = "hermes-agent";
  readonly runtimeVersion = "hermes-agent/1.0";
  readonly transcriptKind = "hermes-agent-sqlite";

  private readonly dbPath: string;

  constructor(opts: HermesAgentAdapterOptions = {}) {
    this.dbPath = opts.dbPath ?? defaultDbPath();
  }

  detect(): DetectionResult {
    if (existsSync(this.dbPath)) {
      return { adapterName: this.name, enabled: true, path: this.dbPath, hint: null };
    }
    return {
      adapterName: this.name,
      enabled: false,
      path: null,
      hint: "Hermes Agent state.db not found — install NousResearch Hermes Agent or set HERMES_HOME.",
    };
  }

  async discover(options?: DiscoverOptions): Promise<ReadonlyArray<string>> {
    if (!existsSync(this.dbPath)) return [];
    let db: Database.Database | undefined;
    try {
      db = new Database(this.dbPath, { readonly: true });
      let rows: { id: string }[];
      if (options?.since) {
        const sinceTs = options.since.getTime() / 1000;
        rows = db
          .prepare<[number], { id: string }>(
            `SELECT id FROM sessions WHERE started_at >= ? ORDER BY started_at ASC`,
          )
          .all(sinceTs);
      } else {
        rows = db
          .prepare<[], { id: string }>(
            `SELECT id FROM sessions ORDER BY started_at ASC`,
          )
          .all();
      }
      return rows.map((r) => r.id);
    } catch {
      return [];
    } finally {
      db?.close();
    }
  }

  async parseSession(sessionId: string): Promise<SessionChunk | null> {
    if (!existsSync(this.dbPath)) return null;
    let db: Database.Database | undefined;
    try {
      db = new Database(this.dbPath, { readonly: true });

      const session = db
        .prepare<[string], SessionRow>(
          `SELECT id, title, started_at, ended_at FROM sessions WHERE id = ?`,
        )
        .get(sessionId);
      if (!session) return null;

      const messages = db
        .prepare<[string], MessageRow>(
          `SELECT id, role, content, tool_calls, tool_name, timestamp
           FROM messages WHERE session_id = ? ORDER BY timestamp ASC`,
        )
        .all(sessionId);

      const turns = extractTurns(messages);
      if (turns.length === 0) return null;

      const startedAt = normalizeTimestamp(session.started_at);
      const endedAt = normalizeTimestamp(session.ended_at ?? session.started_at);
      const transcript = turns.map((t) => `${t.role}: ${t.text}`).join("\n\n");

      const label =
        session.title && session.title.trim()
          ? session.title.slice(0, 80)
          : provisionalLabel(turns);

      return {
        id: safeSessionId("ha", sessionId),
        runtime: this.runtimeVersion,
        runtimeSessionId: sessionId,
        sourcePath: `${this.dbPath}::${sessionId}`,
        startedAt,
        endedAt,
        durationMin: durationMinutes(startedAt, endedAt),
        turnCount: turns.length,
        byteRange: [0, Buffer.byteLength(transcript, "utf8")],
        projectDir: "",
        gitBranch: "",
        text: transcript,
        label,
      };
    } catch {
      return null;
    } finally {
      db?.close();
    }
  }
}
