/**
 * The fixed id of the single-tenant local deployment's team, seeded by
 * migrations 034 (both lanes). A literal — never generated — so it can appear
 * in sqlite column DEFAULTs (Team NLM program spec §2).
 */
export const DEFAULT_TEAM_ID = "team_local";
