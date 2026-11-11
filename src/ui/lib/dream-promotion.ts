/* Promotion pass draft/patch helpers. Drafts hold raw control strings; a
   patch carries only the fields the user changed, and every number field
   must parse to a positive integer (mirrors validatePromotionPass in
   src/core/dream/settings.ts, which rejects anything else). */

export interface PromotionSettings {
  enabled: boolean;
  mode: "dry-run" | "apply";
  sampleSize: number;
  windowDays: number;
  maxLines: number;
  maxBytes: number;
  minCorroboration: number;
}

export interface PromotionDraft {
  enabled: string;
  mode: string;
  sampleSize: string;
  windowDays: string;
  maxLines: string;
  maxBytes: string;
  minCorroboration: string;
}

export const PROMOTION_INT_FIELDS = ["sampleSize", "windowDays", "maxLines", "maxBytes", "minCorroboration"] as const;
export type PromotionIntField = (typeof PROMOTION_INT_FIELDS)[number];

export function promotionDraft(p: PromotionSettings): PromotionDraft {
  return {
    enabled: p.enabled ? "true" : "false",
    mode: p.mode,
    sampleSize: String(p.sampleSize),
    windowDays: String(p.windowDays),
    maxLines: String(p.maxLines),
    maxBytes: String(p.maxBytes),
    minCorroboration: String(p.minCorroboration),
  };
}

export function positiveInt(raw: string): number | null {
  const text = raw.trim();
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export interface PromotionEdit {
  patch: Record<string, boolean | number | string>;
  invalid: PromotionIntField[];
}

export function promotionEdit(current: PromotionSettings, d: PromotionDraft): PromotionEdit {
  const base = promotionDraft(current);
  const patch: Record<string, boolean | number | string> = {};
  const invalid: PromotionIntField[] = [];
  if (d.enabled !== base.enabled) patch["enabled"] = d.enabled === "true";
  if (d.mode !== base.mode) patch["mode"] = d.mode;
  for (const f of PROMOTION_INT_FIELDS) {
    if (d[f] === base[f]) continue;
    const n = positiveInt(d[f]);
    if (n === null) invalid.push(f);
    else patch[f] = n;
  }
  return { patch, invalid };
}

/** Persistence note: durability is claimed only when the daemon says so;
 *  an unknown state (not loaded yet, or a daemon that omits the field) shows nothing. */
export function persistenceNote(persistence: boolean | null | undefined): string | null {
  if (persistence === true) return "Settings are saved on the daemon and survive restarts.";
  if (persistence === false) return "Settings are held in memory only on this daemon and reset on restart.";
  return null;
}
