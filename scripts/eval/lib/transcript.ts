/**
 * Shared helpers for recall-eval mines that reconstruct (prompt, injected
 * context, response) triples from the live hook-log + Claude Code transcripts +
 * the sessions table. Extracted so the gold-candidate dumper and the recall
 * diagnostics share one implementation instead of drifting copies.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

export type Hit = { id: string; score: number };
export type Fire = { cid: string; prompt: string; injId: string; topScore: number; ts: string };

function textOf(m: unknown): string {
  if (typeof m !== "object" || m === null) return "";
  const c = (m as { content?: unknown }).content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.filter((b): b is { type: string; text: string } => typeof b === "object" && b !== null && (b as { type?: string }).type === "text").map((b) => b.text).join(" ");
  return "";
}

let TX: string[] | null = null;
function walk(d: string, o: string[]): void {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p, o);
    else if (e.name.endsWith(".jsonl")) o.push(p);
  }
}
function locate(cid: string): string | null {
  const b = join(homedir(), ".claude", "projects");
  if (!existsSync(b)) return null;
  if (TX === null) { TX = []; walk(b, TX); }
  return TX.find((p) => p.endsWith(`${cid}.jsonl`)) ?? TX.find((p) => p.includes(cid)) ?? null;
}

/** The assistant text immediately following the matching user prompt in a transcript. */
export function responseFor(cid: string, prompt: string): string | null {
  const tp = locate(cid);
  if (!tp) return null;
  const t = readFileSync(tp, "utf8");
  const rows: Array<Record<string, unknown>> = [];
  for (const l of t.split("\n")) { if (!l.trim()) continue; try { rows.push(JSON.parse(l) as Record<string, unknown>); } catch { /* */ } }
  const needle = prompt.trim().slice(0, 25);
  if (!needle) return null;
  const i = rows.findIndex((r) => r["type"] === "user" && textOf(r["message"]).trim().startsWith(needle));
  if (i === -1) return null;
  const resp: string[] = [];
  for (let j = i + 1; j < rows.length; j++) {
    if (rows[j]!["type"] === "user") break;
    if (rows[j]!["type"] === "assistant") { const x = textOf(rows[j]!["message"]).trim(); if (x) resp.push(x); }
  }
  return resp.length ? resp.join(" ").slice(0, 900) : null;
}

/** Deterministic even-spaced subsample of a pool. */
export function evenStride<T>(items: T[], count: number): T[] {
  if (items.length <= count) return items;
  const s = items.length / count;
  const o: T[] = [];
  for (let i = 0; i < count; i++) o.push(items[Math.floor(i * s)]!);
  return o;
}

/** Live inject-fires (mode=live, gate=evaluate, non-empty wouldInject) within `days`. */
export function readInjectFires(days?: number, dedup = true): Fire[] {
  const cutoff = days === undefined ? 0 : Date.now() - days * 86_400_000;
  const seen = new Set<string>();
  const out: Fire[] = [];
  for (const l of readFileSync(join(homedir(), ".nlm", "hook-log.jsonl"), "utf8").split("\n")) {
    if (!l.trim()) continue;
    let d: Record<string, unknown>; try { d = JSON.parse(l) as Record<string, unknown>; } catch { continue; }
    if (d["mode"] !== "live" || d["gate"] !== "evaluate") continue;
    const wi = (d["wouldInject"] as string[]) ?? []; if (!wi.length) continue;
    const ts = String(d["ts"] ?? "");
    if (cutoff && Date.parse(ts) < cutoff) continue;
    const prompt = String(d["promptPreview"] ?? "");
    const cid = String(d["conversationId"] ?? "");
    if (dedup) { const key = `${cid}:${prompt.slice(0, 40)}`; if (seen.has(key)) continue; seen.add(key); }
    const hits = (d["hits"] as Hit[]) ?? [];
    const top = hits.find((h) => h.id === wi[0]);
    out.push({ cid, prompt, injId: wi[0]!, topScore: top?.score ?? Number.NaN, ts });
  }
  return out;
}

/** Reconstruct the injected-context string (label + summary + body) for a session id. */
export function openSessionContext(): { get(id: string): string; close(): void } {
  const db = new Database(join(homedir(), ".nlm", "canonical.sqlite"), { readonly: true });
  const stmt = db.prepare<[string], { label: string; summary: string; body: string }>(
    "SELECT label, COALESCE(summary,'') AS summary, COALESCE(substr(body,1,400),'') AS body FROM sessions WHERE id = ?",
  );
  return {
    get(id: string): string { const r = stmt.get(id); return r ? `${r.label}\n${r.summary}\n${r.body}`.trim() : ""; },
    close(): void { db.close(); },
  };
}
