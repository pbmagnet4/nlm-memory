/**
 * Recency weighting for recall scoring.
 *
 * Multiplies each RecallHit's matchScore by an age-decay factor so identical-
 * relevance sessions sort newer-first. The factor is exponential half-life:
 *
 *     f(age_days) = max(FLOOR, 2 ^ (-age_days / half_life_days))
 *
 * Default half-life: 180 days (6 months). A 180-day-old session scores 0.5×,
 * a 1-year-old session scores 0.25×, an 18-month-old session scores ~0.13×.
 *
 * Default floor: 0.25. A truly-relevant ancient session never drops below
 * a quarter of its raw score — so age alone can't push it out of top results
 * if the keyword/semantic signal is strong enough.
 *
 * Configuration:
 *   NLM_RECALL_DECAY_HALF_LIFE_DAYS  — override the half-life. Set to 0 to
 *                                       disable decay entirely (returns 1.0).
 *   NLM_RECALL_DECAY_FLOOR           — override the floor (0.0 - 1.0 range).
 *
 * Env vars are read once at module load and cached. To change at runtime,
 * call resetRecencyConfigForTest() (test-only) and reimport.
 *
 * Design notes:
 *   - Applied once at finalize() time in recall-service.ts, after per-mode
 *     scoring but before the limit slice. Single call-site covers keyword,
 *     semantic, and hybrid modes uniformly.
 *   - Future startedAt (clock skew) is clamped to multiplier = 1.0.
 *   - Missing/invalid startedAt returns 1.0 (treat as fresh — don't penalize
 *     for data we don't have).
 */

const DEFAULT_HALF_LIFE_DAYS = 180;
const DEFAULT_FLOOR = 0.25;
const MS_PER_DAY = 86_400_000;

interface RecencyConfig {
  readonly halfLifeDays: number;
  readonly floor: number;
  readonly disabled: boolean;
}

let cached: RecencyConfig | null = null;

function loadConfig(): RecencyConfig {
  if (cached) return cached;

  const halfLifeRaw = process.env["NLM_RECALL_DECAY_HALF_LIFE_DAYS"];
  const floorRaw = process.env["NLM_RECALL_DECAY_FLOOR"];

  let halfLifeDays = DEFAULT_HALF_LIFE_DAYS;
  let disabled = false;

  if (halfLifeRaw !== undefined) {
    const parsed = Number.parseFloat(halfLifeRaw);
    if (Number.isFinite(parsed)) {
      if (parsed <= 0) {
        disabled = true;
      } else {
        halfLifeDays = parsed;
      }
    }
  }

  let floor = DEFAULT_FLOOR;
  if (floorRaw !== undefined) {
    const parsed = Number.parseFloat(floorRaw);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) {
      floor = parsed;
    }
  }

  cached = { halfLifeDays, floor, disabled };
  return cached;
}

/**
 * Test-only: drop the cached config so the next call re-reads env vars.
 */
export function resetRecencyConfigForTest(): void {
  cached = null;
}

/**
 * Return the multiplier in (0, 1] for a session whose ISO 8601 `startedAt`
 * timestamp is given. `now` defaults to Date.now() and may be overridden
 * for deterministic tests.
 */
export function recencyMultiplier(startedAt: string | null | undefined, now: number = Date.now()): number {
  const cfg = loadConfig();
  if (cfg.disabled) return 1.0;
  if (!startedAt) return 1.0;

  const started = Date.parse(startedAt);
  if (Number.isNaN(started)) return 1.0;

  const ageMs = now - started;
  if (ageMs <= 0) return 1.0;

  const ageDays = ageMs / MS_PER_DAY;
  const raw = Math.pow(2, -ageDays / cfg.halfLifeDays);
  return Math.max(cfg.floor, raw);
}

/**
 * Read-only view of the active config. Exposed for diagnostics (e.g. the
 * `/api/health` endpoint or operator-facing logs).
 */
export function getRecencyConfig(): RecencyConfig {
  return loadConfig();
}
