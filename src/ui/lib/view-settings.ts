/**
 * View preferences — per-device UI settings persisted in localStorage.
 *
 * Written by Settings → Views; read by the root route (landing), River
 * (density), and Thread (sort). localStorage is the right home: these are
 * device-local display choices, not corpus data the daemon should own.
 */

export type LandingView = "live" | "pulse" | "river" | "thread" | "search";
export type RiverDensity = "compact" | "comfortable" | "spacious";
export type ThreadSort = "recent" | "oldest";

export interface ViewSettings {
  landing: LandingView;
  riverDensity: RiverDensity;
  threadSort: ThreadSort;
}

export const VIEW_SETTINGS_KEY = "nle.settings.views";

export const VIEW_SETTINGS_DEFAULT: ViewSettings = {
  landing: "live",
  riverDensity: "comfortable",
  threadSort: "recent",
};

export function readViewSettings(): ViewSettings {
  if (typeof window === "undefined") return VIEW_SETTINGS_DEFAULT;
  try {
    const raw = window.localStorage.getItem(VIEW_SETTINGS_KEY);
    if (!raw) return VIEW_SETTINGS_DEFAULT;
    return { ...VIEW_SETTINGS_DEFAULT, ...(JSON.parse(raw) as Partial<ViewSettings>) };
  } catch {
    return VIEW_SETTINGS_DEFAULT;
  }
}

export function writeViewSettings(values: ViewSettings): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(VIEW_SETTINGS_KEY, JSON.stringify(values));
}
