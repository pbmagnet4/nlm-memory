/**
 * resolveTeamByToken — the one auth-only tenant-resolution function every
 * gated network transport routes through (program spec §3: "The tenant is
 * resolved from the authenticated credential and from nothing else").
 *
 * Mechanism: sha256-hex the presented bearer token, look up
 * `team_tokens WHERE token_hash = $hash AND revoked_at IS NULL`, return the
 * team_id. No ambient derivation, no request parameter, no fallback chain —
 * a token that doesn't resolve returns null and the caller denies.
 */

import { createHash } from "node:crypto";
import type { TeamTokenStorePort } from "./team-token-store.js";

export interface ResolvedTeam {
  readonly teamId: string;
}

export function hashTeamToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export async function resolveTeamByToken(
  store: TeamTokenStorePort,
  presentedToken: string | undefined | null,
): Promise<ResolvedTeam | null> {
  if (!presentedToken) return null;
  const hash = hashTeamToken(presentedToken);
  const row = await store.findActiveByHash(hash);
  return row ? { teamId: row.teamId } : null;
}
