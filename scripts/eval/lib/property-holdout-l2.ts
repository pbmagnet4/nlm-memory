import { readFileSync } from "node:fs";
import type { Card } from "./property-holdout-cards.js";
import { chatOnce } from "./chat-client.js";
import { fileHash, pathsIn, readJson, sha256, writePrivate, SEED, type Manifest } from "./property-holdout-io.js";
import { validateLabel, type CardLabel } from "./property-holdout-labels.js";
import { L2_PROMPT_PATH } from "./property-holdout.js";

export type Complete = (system: string, user: string) => Promise<string>;

export function gatewayComplete(baseUrl: string, apiKey: string | undefined, model: string): Complete {
  return (system, user) => chatOnce({
    baseUrl, model, ...(apiKey ? { apiKey } : {}), temperature: 0, maxTokens: 700, timeoutMs: 180_000,
    // The alias is shared: switch thinking off for this request only, never in gateway settings.
    extraBody: { chat_template_kwargs: { enable_thinking: false } },
  }, system, user);
}

/** The catalog is shuffled per card, deterministically, so L2 never sees L1's order. */
export function shuffledCatalog(card: Card): Card["catalog"] {
  return [...card.catalog].sort((a, b) => sha256(`${SEED}:l2:${card.id}:${a.slug}`).localeCompare(sha256(`${SEED}:l2:${card.id}:${b.slug}`)));
}
export function l2Message(card: Card): string {
  const { id: _id, extra: _extra, ...visible } = card as Card & { extra?: string };
  return JSON.stringify({ ...visible, catalog: shuffledCatalog(card) }, null, 2);
}
export function parseAnswer(card: Card, text: string): CardLabel {
  const start = text.indexOf("{"); const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error(`label for ${card.id}: no JSON object in the answer`);
  const raw = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  const { justification, ...rest } = raw;
  return validateLabel(card, typeof justification === "string" && justification ? { ...rest, note: justification } : rest);
}

export interface L2Result { labelled: number; failures: { id: string; reason: string }[] }

export async function runL2(dir: string, model: string, complete: Complete): Promise<L2Result> {
  const p = pathsIn(dir);
  const manifest = readJson<Manifest>(p.manifest);
  if (manifest.l2PromptHash !== fileHash(L2_PROMPT_PATH)) throw new Error("L2 prompt does not match the manifest hash");
  if (!manifest.draw || fileHash(p.cards) !== manifest.draw.cardsHash) throw new Error("cards.json does not match the manifest hash");
  const system = readFileSync(L2_PROMPT_PATH, "utf8");
  const cards = readJson<{ cards: Card[] }>(p.cards).cards;
  const labels: Record<string, CardLabel> = {}; const failures: L2Result["failures"] = [];
  for (const card of cards) {
    try { labels[card.id] = parseAnswer(card, await complete(system, l2Message(card))); }
    catch (e) { failures.push({ id: card.id, reason: e instanceof Error ? e.message : String(e) }); }
  }
  writePrivate(p.l2, { labeller: "L2", seed: SEED, model, promptHash: manifest.l2PromptHash, temperature: 0, sittings: [], labels, failures });
  return { labelled: Object.keys(labels).length, failures };
}
