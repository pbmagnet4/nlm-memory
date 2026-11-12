/**
 * Hermetic test environment (T1760).
 *
 * The operator's shell exports live deployment config (NLM_FORMAT=toon,
 * NLM_PORT, NLM_DREAM_PROMOTE_PASS/APPLY, provider keys, ...). Vitest workers
 * inherit `process.env`, so roughly 75 tests read that config instead of their
 * own defaults — tests/integration/mcp-context.test.ts parses an MCP response
 * as JSON while the server TOON-encodes it, NLM_PORT redirects an HTTP test at
 * the live server, and the dreaming tests find promotion switched on. The suite
 * only reproduces under `env -i`, which nobody runs locally.
 *
 * This module is registered as vitest `setupFiles`, so it is imported in every
 * worker before any test module — `src/**` therefore sees the same environment
 * it sees under `env -i`. Tests that need a variable set it themselves
 * (`vi.stubEnv`, or an explicit child-process env); that happens after this
 * scrub, so their behaviour is unchanged.
 */

// Keys the scrub skips. They are not deployment config: they are the values
// the suite (or CI) injects on purpose, and skipping them keeps the behaviour
// independent of whether config `test.env` lands before or after setupFiles.
// - NLM_STATE_ROOT / NLM_RECALL_REWRITE_DEFAULT: the floors vitest.config.ts
//   injects (state writes go to a temp root, rewrite stays off).
// - NLM_PG_TEST_URL: not deployment config but the explicit opt-in CI passes to
//   `npm run test:pg`; every *.pg.test.ts skips when it is absent.
const SKIP = [
  "NLM_STATE_ROOT",
  "NLM_RECALL_REWRITE_DEFAULT",
  "NLM_PG_TEST_URL",
] as const;

// App config this app reads that is not NLM_-prefixed
// (src/**: rg -o "process\\.env[.\\[]..." src | sort -u). Not PATH/HOME/TMPDIR
// or anything the toolchain needs.
const OTHER_APP_CONFIG = [
  "AIDER_CHAT_HISTORY_FILE", // other agents' session stores
  "DEEPSEEK_API_KEY", // live LLM provider key
  "HERMES_HOME",
  "OLLAMA_HOST",
  "OPENCODE_DB_PATH",
  "PI_SESSIONS_PATH",
  "TELEGRAM_BOT_TOKEN", // digest push target
  "TELEGRAM_CHAT_ID",
] as const;

const SCRUB_OTHER = new Set<string>(OTHER_APP_CONFIG);

/**
 * Delete every NLM_-prefixed key and the non-prefixed app config in
 * {@link OTHER_APP_CONFIG} from `env`, leaving the {@link SKIP} keys alone.
 * Returns the keys it removed, sorted. Defaults to the live `process.env`.
 */
export function scrubOperatorEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const skip = new Set<string>(SKIP);
  const removed: string[] = [];
  for (const key of Object.keys(env)) {
    if (skip.has(key)) continue;
    if (/^NLM_/.test(key) || SCRUB_OTHER.has(key)) {
      delete env[key];
      removed.push(key);
    }
  }
  return removed.sort();
}

// Side effect on import — this is what makes each worker hermetic.
scrubOperatorEnv();
