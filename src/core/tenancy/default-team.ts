/**
 * The fixed id of the single-tenant local deployment's team, seeded by
 * migrations 034 (both lanes). A literal — never generated — so it can appear
 * in sqlite column DEFAULTs (tenancy design doc, kept privately in .superpowers/).
 */
export const DEFAULT_TEAM_ID = "team_local";
