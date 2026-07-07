/**
 * `nlm digest` — compose a daily-activity digest from the running daemon and
 * either print it to stdout (default) or POST it to Telegram.
 *
 * Talks to the daemon over HTTP so it works regardless of where the daemon is
 * actually running. If the daemon is unreachable, the Telegram path posts a
 * "daemon unreachable" alert instead of failing silently — the cron user is
 * specifically watching for this telemetry, so silence is worse than noise.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  composeDigest,
  type DigestPrecision,
  type RecallStats,
  type RecentEntry,
} from "@core/digest/compose.js";
import { computePrecision } from "@core/recall/precision.js";
import { readHookRecallLog } from "@core/recall/hook-recall-log.js";
import { readCitationLog } from "@core/recall/citation-log.js";
import { checkHookLiveness, type SessionRow, type HookLogEntry } from "@core/digest/hook-liveness.js";
import { checkHookInjection } from "@core/digest/hook-injection.js";
import { hookAuthHeaders } from "../hook/hook-auth.js";

export interface DigestOptions {
  readonly port: number;
  readonly telegram: boolean;
  readonly timeoutMs?: number;
}

export interface DigestResult {
  readonly text: string;
  readonly delivered: "stdout" | "telegram" | "telegram-alert";
  readonly daemonReachable: boolean;
}

export async function runDigest(opts: DigestOptions): Promise<DigestResult> {
  const base = `http://localhost:${opts.port}`;
  const timeoutMs = opts.timeoutMs ?? 8000;

  let stats: RecallStats | null = null;
  let recent: ReadonlyArray<RecentEntry> = [];
  let sessions: ReadonlyArray<SessionRow> = [];
  let daemonError: string | null = null;

  try {
    const [statsRes, recentRes, datasetRes] = await Promise.all([
      fetchJson(`${base}/api/recall/stats`, timeoutMs),
      fetchJson(`${base}/api/recall/recent?limit=200`, timeoutMs),
      fetchJson(`${base}/api/dataset`, timeoutMs * 2),
    ]);
    stats = statsRes as RecallStats;
    recent = ((recentRes as { entries?: ReadonlyArray<RecentEntry> }).entries) ?? [];
    sessions = ((datasetRes as { sessions?: ReadonlyArray<SessionRow> }).sessions) ?? [];
  } catch (e) {
    daemonError = e instanceof Error ? e.message : String(e);
  }

  if (daemonError !== null || stats === null) {
    const text =
      `NLM digest — ${todayStr()}\n\n` +
      `Daemon unreachable at ${base}\n${daemonError ?? "no stats returned"}`;
    if (opts.telegram) {
      await postTelegram(text);
      return { text, delivered: "telegram-alert", daemonReachable: false };
    }
    process.stdout.write(`${text}\n`);
    return { text, delivered: "stdout", daemonReachable: false };
  }

  const hookLogPath = process.env["NLM_HOOK_LOG"] ?? join(homedir(), ".nlm", "hook-log.jsonl");
  const hookLogExists = existsSync(hookLogPath);
  const hookLog: HookLogEntry[] = hookLogExists ? readHookLog(hookLogPath) : [];
  const livenessAlert = checkHookLiveness({
    sessions,
    hookLog,
    hookLogPath,
    hookLogExists,
  });
  const injectionResult = checkHookInjection(hookLog);
  const hookAlert =
    [livenessAlert, injectionResult.message].filter(Boolean).join("\n") || null;

  // True cited-precision over the 7-day window (the honest "was recall useful"
  // metric). Best-effort: a log-read failure must not break the digest.
  let precision: DigestPrecision | null = null;
  try {
    const [recallEntries, citationEntries] = await Promise.all([
      readHookRecallLog(7),
      readCitationLog(7),
    ]);
    const result = computePrecision(recallEntries, citationEntries);
    precision = {
      precisionAtK: result.precisionAtK,
      conversationCount: result.conversationCount,
    };
  } catch {
    precision = null;
  }

  const text = composeDigest({
    stats,
    recent,
    port: opts.port,
    hookAlert,
    precision,
  });

  if (opts.telegram) {
    await postTelegram(text);
    return { text, delivered: "telegram", daemonReachable: true };
  }
  process.stdout.write(`${text}\n`);
  return { text, delivered: "stdout", daemonReachable: true };
}

async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: hookAuthHeaders({ "user-agent": "nlm-digest/1.0" }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`${url} → ${res.status} ${res.statusText}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function readHookLog(path: string): HookLogEntry[] {
  const out: HookLogEntry[] = [];
  const raw = readFileSync(path, "utf8");
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as HookLogEntry);
    } catch {
      // Corrupt line — skip silently. The digest is best-effort observability,
      // not a parser test.
    }
  }
  return out;
}

async function postTelegram(text: string): Promise<void> {
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  const chatId = process.env["TELEGRAM_CHAT_ID"];
  if (!token || !chatId) {
    throw new Error("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set for --telegram");
  }
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const body = new URLSearchParams({
    chat_id: chatId,
    text,
    disable_web_page_preview: "true",
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": "nlm-digest/1.0",
      },
      body,
      signal: controller.signal,
    });
    const payload = (await res.json()) as { ok?: boolean; description?: string };
    if (!payload.ok) {
      throw new Error(`telegram api error: ${payload.description ?? "unknown"}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

function todayStr(): string {
  const d = new Date();
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()]!;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${weekday} ${y}-${m}-${day}`;
}
