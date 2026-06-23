/**
 * Dump a stable, balanced sample of (prompt, injected-context, response) triples
 * for frontier labeling into a usefulness gold set. Writes candidates JSONL +
 * a readable view. The gold set (with labels) lives OUTSIDE the repo
 * (~/.nlm/eval/) because it contains real prompts/responses.
 *
 * Run: npx tsx scripts/eval/dump-gold-candidates.ts [--thin=10] [--specific=10] [--days=60]
 *        [--out=/tmp/gold-candidates.jsonl]
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { topicalWordCount } from "../../src/hook/recent-context.js";

const get = (k: string) => { const h = process.argv.find((a) => a.startsWith(`--${k}=`)); return h ? h.slice(k.length + 3) : undefined; };
const N_THIN = Number.parseInt(get("thin") ?? "10", 10);
const N_SPEC = Number.parseInt(get("specific") ?? "10", 10);
const DAYS = Number.parseInt(get("days") ?? "60", 10);
const OUT = get("out") ?? "/tmp/gold-candidates.jsonl";

function textOf(m: unknown): string {
  if (typeof m !== "object" || m === null) return "";
  const c = (m as { content?: unknown }).content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.filter((b): b is { type: string; text: string } => typeof b === "object" && b !== null && (b as { type?: string }).type === "text").map((b) => b.text).join(" ");
  return "";
}
let TX: string[] | null = null;
function walk(d: string, o: string[]): void { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p, o); else if (e.name.endsWith(".jsonl")) o.push(p); } }
function locate(cid: string): string | null { const b = join(homedir(), ".claude", "projects"); if (!existsSync(b)) return null; if (TX === null) { TX = []; walk(b, TX); } return TX.find((p) => p.endsWith(`${cid}.jsonl`)) ?? TX.find((p) => p.includes(cid)) ?? null; }
function responseAfter(t: string, prompt: string): string | null {
  const rows: Array<Record<string, unknown>> = [];
  for (const l of t.split("\n")) { if (!l.trim()) continue; try { rows.push(JSON.parse(l) as Record<string, unknown>); } catch { /* */ } }
  const needle = prompt.trim().slice(0, 25); if (!needle) return null;
  const i = rows.findIndex((r) => r["type"] === "user" && textOf(r["message"]).trim().startsWith(needle));
  if (i === -1) return null;
  const resp: string[] = [];
  for (let j = i + 1; j < rows.length; j++) { if (rows[j]!["type"] === "user") break; if (rows[j]!["type"] === "assistant") { const x = textOf(rows[j]!["message"]).trim(); if (x) resp.push(x); } }
  return resp.length ? resp.join(" ").slice(0, 900) : null;
}
function evenStride<T>(items: T[], count: number): T[] { if (items.length <= count) return items; const s = items.length / count; const o: T[] = []; for (let i = 0; i < count; i++) o.push(items[Math.floor(i * s)]!); return o; }

const db = new Database(join(homedir(), ".nlm", "canonical.sqlite"), { readonly: true });
const summ = db.prepare<[string], { label: string; summary: string; body: string }>("SELECT label, COALESCE(summary,'') AS summary, COALESCE(substr(body,1,400),'') AS body FROM sessions WHERE id = ?");

const cutoff = Date.now() - DAYS * 86_400_000;
const seen = new Set<string>();
const thin: Array<{ cid: string; prompt: string; inj: string }> = [];
const spec: Array<{ cid: string; prompt: string; inj: string }> = [];
for (const l of readFileSync(join(homedir(), ".nlm", "hook-log.jsonl"), "utf8").split("\n")) {
  if (!l.trim()) continue;
  let d: Record<string, unknown>; try { d = JSON.parse(l) as Record<string, unknown>; } catch { continue; }
  if (d["mode"] !== "live" || d["gate"] !== "evaluate") continue;
  const wi = (d["wouldInject"] as string[]) ?? []; if (!wi.length) continue;
  if (Date.parse(String(d["ts"] ?? "")) < cutoff) continue;
  const prompt = String(d["promptPreview"] ?? ""); const cid = String(d["conversationId"] ?? "");
  const key = `${cid}:${prompt.slice(0, 40)}`; if (seen.has(key)) continue; seen.add(key);
  (topicalWordCount(prompt) < 3 ? thin : spec).push({ cid, prompt, inj: wi[0]! });
}

const rows: Array<{ key: string; band: string; prompt: string; context: string; response: string }> = [];
for (const [band, pool, n] of [["thin", thin, N_THIN], ["specific", spec, N_SPEC]] as const) {
  for (const f of evenStride(pool, n * 2)) {
    if (rows.filter((r) => r.band === band).length >= n) break;
    const tp = locate(f.cid); if (!tp) continue;
    const resp = responseAfter(readFileSync(tp, "utf8"), f.prompt); if (!resp) continue;
    const r = summ.get(f.inj); const context = r ? `${r.label}\n${r.summary}\n${r.body}`.trim() : "";
    if (!context) continue;
    const key = createHash("sha1").update(f.cid + f.prompt).digest("hex").slice(0, 10);
    rows.push({ key, band, prompt: f.prompt, context, response: resp });
  }
}
db.close();
writeFileSync(OUT, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
console.error(`wrote ${rows.length} candidates to ${OUT}`);
for (const r of rows) {
  console.log(`\n### ${r.key}  [${r.band}]`);
  console.log(`PROMPT:   ${r.prompt.replace(/\n/g, " ").slice(0, 150)}`);
  console.log(`INJECTED: ${r.context.replace(/\n/g, " ").slice(0, 240)}`);
  console.log(`RESPONSE: ${r.response.replace(/\n/g, " ").slice(0, 380)}`);
}
