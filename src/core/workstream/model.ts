// src/core/workstream/model.ts
import { randomUUID } from "node:crypto";
import type { Fact, CodeExemplar } from "../../shared/types.js";

export type WorkstreamStatus = "active" | "merged" | "retired";

export interface Workstream {
  readonly id: string;
  readonly label: string;
  readonly status: WorkstreamStatus;
  readonly mergedInto: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastSessionAt: string | null;
}

export type BindingSource = "classifier" | "operator" | "backfill";

export interface WorkstreamCandidate {
  readonly workstreamId: string;
  readonly entities: ReadonlyArray<string>;
}

export interface MatchThresholds { readonly high: number; readonly low: number; }
export interface MatchWeights { readonly semantic: number; readonly entity: number; }

export interface MatchInputs {
  readonly sessionEntities: ReadonlyArray<string>;
  readonly neighborScores: ReadonlyMap<string, number>;
  readonly candidates: ReadonlyArray<WorkstreamCandidate>;
  readonly thresholds: MatchThresholds;
  readonly weights: MatchWeights;
}

export type MatchDecision =
  | { readonly kind: "bind"; readonly workstreamId: string; readonly confidence: number }
  | { readonly kind: "ambiguous"; readonly candidates: ReadonlyArray<{ readonly workstreamId: string; readonly score: number }> }
  | { readonly kind: "create"; readonly confidence: number };

export interface WorkstreamRollup {
  readonly workstream: Workstream;
  readonly sessionIds: ReadonlyArray<string>;
  readonly facts: ReadonlyArray<Fact>;
  readonly exemplars: ReadonlyArray<CodeExemplar>;
}

export function makeWorkstreamId(): string {
  return `ws_${randomUUID()}`;
}

export function normalizeLabel(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, " ");
}
