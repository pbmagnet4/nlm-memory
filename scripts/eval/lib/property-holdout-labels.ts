import { existsSync, readFileSync, renameSync } from "node:fs";
import { chmodSync, writeFileSync } from "node:fs";
import { fileHash, pathsIn, readJson, writePrivate } from "./property-holdout-io.js";
import type { Card } from "./property-holdout-cards.js";

export const ROLES = ["owner", "dependency", "runtime-namespace", "quoted-input", "incidental"] as const;
export type Role = (typeof ROLES)[number];
export type Confidence = "sure" | "unsure";

export interface FactLabel { owner: string; roles: Record<string, Role>; confidence: Confidence; note?: string }
export interface SessionLabel {
  relevant: string[]; quotedInputOnly: string[]; boilerplateOnly: string[]; confidence: Confidence; note?: string;
  adjudicated?: { changed: boolean; confidence: Confidence };
}
export type CardLabel = FactLabel | SessionLabel;
export interface LabelsFile {
  labeller: "L1" | "L2"; seed: string;
  sittings: { startedAt: string; endedAt: string; cards: number }[];
  labels: Record<string, CardLabel>;
}
export interface Seal { labelsHash: string; sealedAt: string; cards: number }

const isConfidence = (v: unknown): v is Confidence => v === "sure" || v === "unsure";

export function validateLabel(card: Card, label: unknown): CardLabel {
  const slugs = new Set(card.catalog.map((c) => c.slug));
  const fail = (why: string): never => { throw new Error(`label for ${card.id}: ${why}`); };
  if (typeof label !== "object" || label === null) return fail("not an object");
  const l = label as Record<string, unknown>;
  if (!isConfidence(l["confidence"])) fail("confidence must be sure or unsure");
  const list = (key: string): string[] => {
    const v = l[key];
    if (!Array.isArray(v) || v.some((s) => typeof s !== "string" || !slugs.has(s))) fail(`${key} must list catalog slugs`);
    return v as string[];
  };
  const note = typeof l["note"] === "string" && l["note"] ? { note: l["note"] as string } : {};
  if (card.type === "fact") {
    const owner = l["owner"];
    if (typeof owner !== "string" || !(owner === "none" || owner === "ambiguous" || slugs.has(owner))) fail("owner must be a catalog slug, none or ambiguous");
    const roles = l["roles"];
    if (typeof roles !== "object" || roles === null) return fail("roles missing");
    for (const [slug, role] of Object.entries(roles)) if (!slugs.has(slug) || !(ROLES as readonly unknown[]).includes(role)) fail(`bad role for ${slug}`);
    return { owner: owner as string, roles: roles as Record<string, Role>, confidence: l["confidence"] as Confidence, ...note };
  }
  const base: SessionLabel = { relevant: list("relevant"), quotedInputOnly: list("quotedInputOnly"), boilerplateOnly: list("boilerplateOnly"), confidence: l["confidence"] as Confidence, ...note };
  const flagged = new Set([...base.quotedInputOnly, ...base.boilerplateOnly]);
  if (base.relevant.some((slug) => flagged.has(slug))) fail("a property cannot be relevant and quoted-input-only or boilerplate-only");
  const adj = l["adjudicated"] as { changed?: unknown; confidence?: unknown } | undefined;
  if (adj !== undefined) {
    if (typeof adj.changed !== "boolean" || !isConfidence(adj.confidence)) fail("adjudicated needs changed and confidence");
    base.adjudicated = { changed: adj.changed as boolean, confidence: adj.confidence as Confidence };
  }
  return base;
}

/** Atomic rewrite at mode 0600 so a crash mid-sitting never leaves half a file. */
export function saveLabels(dir: string, file: LabelsFile): void {
  const target = pathsIn(dir).labels;
  const temp = `${target}.tmp`;
  writeFileSync(temp, JSON.stringify(file, null, 2), { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, target);
}
export function loadLabels(dir: string, labeller: "L1" | "L2", seed: string): LabelsFile {
  const path = pathsIn(dir).labels;
  return existsSync(path) ? readJson<LabelsFile>(path) : { labeller, seed, sittings: [], labels: {} };
}
export const isSealed = (dir: string): boolean => existsSync(pathsIn(dir).sealed);

export function sealLabels(dir: string, cards: readonly Card[], now: Date): Seal {
  const p = pathsIn(dir);
  if (isSealed(dir)) throw new Error("labels are already sealed");
  if (!existsSync(p.labels)) throw new Error("no labels to seal");
  const labels = readJson<LabelsFile>(p.labels).labels;
  const missing = cards.filter((c) => !(c.id in labels));
  if (missing.length > 0) throw new Error(`cannot seal: ${missing.length} cards are unlabelled`);
  const seal: Seal = { labelsHash: fileHash(p.labels), sealedAt: now.toISOString(), cards: cards.length };
  writePrivate(p.sealed, seal);
  return seal;
}
export function readSeal(dir: string): Seal {
  return JSON.parse(readFileSync(pathsIn(dir).sealed, "utf8")) as Seal;
}
