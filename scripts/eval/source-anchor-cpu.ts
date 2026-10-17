/** Offline CPU diagnostic: source/fact development data only, no queries or labels. */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, createReadStream, mkdirSync, writeFileSync } from "node:fs";
import { constants } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { bodyVersion } from "../../src/core/context/source-version.js";
import { locateSourceAnchor, validateSourceAnchor, verifySourceQuote } from "../../src/core/facts/source-anchor.js";

const [snapshot, output] = process.argv.slice(2);
if (!snapshot || !output) throw new Error("Usage: tsx scripts/eval/source-anchor-cpu.ts SNAPSHOT OUTPUT_DIRECTORY");
async function sha256(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
const before = await sha256(snapshot);
mkdirSync(output, { recursive: true, mode: 0o700 });
const clone = join(output, "source-clone.sqlite");
if (!existsSync(clone)) copyFileSync(snapshot, clone, constants.COPYFILE_EXCL);
if (await sha256(clone) !== before) throw new Error("Existing clone differs from frozen snapshot");
const db = new Database(clone, { readonly: true, fileMustExist: true });
const ioStart = performance.now();
type QuoteRow = { id: string; source_session_id: string; source_quote: string; tenant_id: string };
let quotes: QuoteRow[];
let workload: { body: string; quote: string; version: string; anchor: ReturnType<typeof locateSourceAnchor> }[];
let legacyVersions: number;
try {
  quotes = db.prepare<[], QuoteRow>(`SELECT id, source_session_id, source_quote, tenant_id FROM facts
    WHERE source_quote IS NOT NULL AND source_quote <> ''`).all();
  const sample = quotes.map((row) => ({ row, key: bodyVersion("T806-source-anchor-cpu:" + row.id) }))
    .sort((a, b) => a.key.localeCompare(b.key)).slice(0, 256).map(({ row }) => row);
  const hasVersion = db.prepare("PRAGMA table_info(sessions)").all().some((r) => (r as { name: string }).name === "body_version");
  const source = db.prepare<[string, string], { body: string | null; body_version: string | null }>(
    `SELECT body, ${hasVersion ? "body_version" : "NULL AS body_version"} FROM sessions WHERE id = ? AND tenant_id = ?`);
  legacyVersions = 0;
  workload = sample.flatMap((f) => {
    const s = source.get(f.source_session_id, f.tenant_id);
    if (!s?.body_version) legacyVersions++;
    if (!s?.body) return [{ body: "", quote: f.source_quote, version: "", anchor: { status: "missing" as const } }];
    return [{ body: s.body, quote: f.source_quote, version: bodyVersion(s.body), anchor: locateSourceAnchor(s.body, f.source_quote) }];
  });
} finally { db.close(); }
const preloadMs = performance.now() - ioStart;
for (const row of workload) {
  if (row.anchor.status === "verified" && row.body.slice(row.anchor.start, row.anchor.end) !== row.quote) throw new Error("Literal parity failed");
  if (row.anchor.status === "verified" && validateSourceAnchor(row.anchor, null).status !== "stale") throw new Error("Missing-version verification failed");
}
const repeats = 200;
let sink = 0;
function cpu(rows: typeof workload, verify: (row: typeof workload[number]) => boolean) {
  const start = process.cpuUsage();
  for (let repeat = 0; repeat < repeats; repeat++) for (const row of rows) sink += Number(verify(row));
  const elapsed = process.cpuUsage(start);
  return (elapsed.user + elapsed.system) / 1_000;
}
function measure(rows: typeof workload, legacy = false) {
  const scans: number[] = [], anchors: number[] = [];
  const scan = (r: typeof workload[number]) => r.body.includes(r.quote);
  const validate = (r: typeof workload[number]) => verifySourceQuote(
    { sourceQuote: r.quote, ...(legacy ? {} : { sourceAnchor: r.anchor }) },
    { body: r.body, bodyVersion: legacy ? null : r.version }) === true;
  cpu(rows, scan); cpu(rows, validate);
  for (let round = 0; round < 7; round++) {
    if (round % 2) { anchors.push(cpu(rows, validate)); scans.push(cpu(rows, scan)); }
    else { scans.push(cpu(rows, scan)); anchors.push(cpu(rows, validate)); }
  }
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
  return { rows: rows.length, operationsPerRound: repeats * rows.length, scanCpuMs: scans, anchorCpuMs: anchors,
    medianScanCpuMs: median(scans), medianAnchorCpuMs: median(anchors), reductionPercent: 100 * (1 - median(anchors) / median(scans)) };
}
const result = {
  snapshotSha256: before, cloneSha256: await sha256(clone), snapshotUnchanged: before === await sha256(snapshot),
  sampling: "256 quoted facts, ascending SHA256('T806-source-anchor-cpu:' + fact.id), no query/outcome data",
  quotedPopulation: quotes.length, sampled: workload.length, sampledMissingPersistedVersions: legacyVersions,
  statuses: Object.fromEntries(["verified", "invalid", "ambiguous", "missing"].map((s) => [s, workload.filter((r) => r.anchor.status === s).length])),
  preparationIncludingDbIoAndOfflineAnchoringMs: preloadMs,
  allQuotedCurrentLegacyReadOnlyVerification: legacyVersions === workload.length ? measure(workload, true) : null,
  allQuotedCounterfactualNewWrites: measure(workload),
  verifiedUniqueSubsetCounterfactualNewWrites: measure(workload.filter((r) => r.anchor.status === "verified")),
  limitations: ["CPU only; excludes DB I/O, ingest normalization/hashing, joins and whole-request latency.",
    "Anchors are created offline in RAM for this comparison, never written into either database.",
    "Historical persisted anchors stay unverified; quoteVerified can use read-only ephemeral unique literal proof. The actual all-legacy workload is measured separately.",
    "All-quoted includes() and unique-anchor verification differ for repeated quotes; only current versioned negative assessments avoid fallback; legacy/stale candidates retain fallback verification cost. Only the unique subset has equal positive semantics.",
    "Expansion still reads a full body then slices in JavaScript; no SQL range optimization."],
  sink,
};
writeFileSync(join(output, "cpu-results.json"), JSON.stringify(result, null, 2), { mode: 0o600 });
console.log(JSON.stringify(result));
