// src/core/workstream/thresholds.ts
import type { MatchThresholds, MatchWeights } from "./model.js";

/** Provisional — replaced by the gold-set score distribution in Plan D (#367 §13). */
export const DEFAULT_THRESHOLDS: MatchThresholds = { high: 0.55, low: 0.3 };
export const DEFAULT_WEIGHTS: MatchWeights = { semantic: 0.5, entity: 0.5 };
