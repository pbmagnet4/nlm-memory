import type { Session } from "../../src/shared/types.js";
import { makeSession } from "./sessions.js";

/**
 * A fixed, realistic corpus for recall-quality regression testing.
 * `body` is populated on every session because FTS5 keyword search indexes
 * label + summary + body. Decision/open text is also present in `body`
 * (mirrors production: markers are extracted from the body markdown).
 */
export const GOLDEN_CORPUS: ReadonlyArray<Session> = [
  makeSession({
    id: "g_fts",
    label: "FTS5 vs pgvector for recall search backend",
    summary: "Compared SQLite FTS5 lexical search against pgvector for the recall layer",
    body: "Evaluated FTS5 versus pgvector. FTS5 ships with SQLite and stays zero-config. pgvector needs Postgres running which breaks the five-minute install.",
    decisions: ["Use FTS5 for the lexical recall leg"],
    entities: ["NLM"],
  }),
  makeSession({
    id: "g_hono",
    label: "Hono router setup on port 3940",
    summary: "Wired the Hono HTTP router and mounted the recall API",
    body: "Set up Hono as the HTTP framework. Mounted routes for recall, sessions, and the live dashboard on port 3940.",
    decisions: ["Chose Hono over Express for HTTP routing"],
    entities: ["NLM"],
  }),
  makeSession({
    id: "g_pgvector",
    label: "pgvector migration plan for the power tier",
    summary: "Sketched the Postgres mirror behind the SessionStore port",
    body: "Planned a PostgresSessionStore satisfying the same port as SqliteSessionStore. pgvector handles the vector index for users already running Postgres.",
    open: ["Timing of the SQLite to Postgres cutover"],
    entities: ["NLM", "Postgres"],
  }),
  makeSession({
    id: "g_tauri",
    label: "Tauri desktop packaging for v2 distribution",
    summary: "Plan to wrap the server and SPA in Tauri for signed installers",
    body: "Tauri hosts the Vite SPA in a webview and runs the Node server as a sidecar. Produces dmg, exe, and deb installers.",
    open: ["Whether to rewrite the server in Rust later"],
    entities: ["NLM"],
  }),
  makeSession({
    id: "g_classifier",
    label: "Ollama classifier latency during backfill",
    summary: "The Ollama classifier runs about one session per second",
    body: "Backfilling a year of history is slow because the Ollama classifier processes roughly one session per second. Considered parallelizing the calls.",
    open: ["Parallelize classifier calls or document the DeepSeek path"],
    entities: ["NLM", "Ollama"],
  }),
  makeSession({
    id: "g_supersede",
    label: "Fact supersedence policy on subject predicate collision",
    summary: "Deterministic supersedence when a newer fact collides with an older one",
    body: "When a new fact shares the same subject and predicate as a current fact, the older row is marked superseded by the new one. Always supersede, even on same value.",
    decisions: ["Always supersede on subject predicate collision"],
    entities: ["NLM"],
  }),
  makeSession({
    id: "g_toon",
    label: "TOON encoding for MCP tool responses",
    summary: "Encode MCP responses as TOON to cut token usage",
    body: "The MCP server encodes tool responses as TOON when NLM_FORMAT is set to toon. Falls back to JSON when toonEncode throws.",
    decisions: ["TOON-encode MCP responses behind the NLM_FORMAT env flag"],
    entities: ["NLM"],
  }),
  makeSession({
    id: "g_camofox",
    label: "Camofox audit of the search page",
    summary: "Ran a Camofox browser audit against the recall search UI",
    body: "Camofox audit found the search page returned zero results because the static build ignored query strings. Fixed with client-side hydration.",
    open: ["Should entity facet links filter within search"],
    entities: ["NLM", "Camofox"],
  }),
];

/** query → session id expected to appear in the top 3 keyword results. */
export const GOLDEN_QUERIES: ReadonlyArray<{ query: string; expectTop3: string }> = [
  { query: "FTS5 pgvector search backend", expectTop3: "g_fts" },
  { query: "Hono router", expectTop3: "g_hono" },
  { query: "Tauri packaging installers", expectTop3: "g_tauri" },
  { query: "Ollama classifier latency", expectTop3: "g_classifier" },
  { query: "fact supersedence collision", expectTop3: "g_supersede" },
  { query: "TOON encoding MCP", expectTop3: "g_toon" },
];
