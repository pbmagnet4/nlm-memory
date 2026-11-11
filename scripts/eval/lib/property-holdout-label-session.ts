import { mentions } from "./property-holdout-strata.js";
import type { Card, FactCard, SessionCard } from "./property-holdout-cards.js";
import { ROLES, loadLabels, saveLabels, validateLabel, type Role, type SessionLabel } from "./property-holdout-labels.js";
import { SEED } from "./property-holdout-io.js";

export interface Terminal { ask(prompt: string): Promise<string>; print(text: string): void }
export const SITTING_MINUTES = 45;
const QUIT = "q";

const slugList = (raw: string): string[] => raw.split(",").map((s) => s.trim()).filter(Boolean);

function show(card: Card, extra: boolean): string {
  const head = card.type === "fact"
    ? `FACT (${card.runtime})\n  ${card.fact.kind} | ${card.fact.subject} | ${card.fact.predicate} | ${card.fact.value}`
    : `SESSION (${card.runtime})\n  label: ${card.label}\n  summary: ${card.summary}`;
  const prompts = card.userPrompts.map((p, i) => `  [user ${i + 1}] ${p}`).join("\n");
  return [head, prompts, `--- context ---\n${card.context}`, ...(extra && card.type === "session" ? [`--- more ---\n${card.extra}`] : []),
    `--- catalog ---\n${card.catalog.map((c) => `${c.slug} (${c.label})`).join(", ")}`].join("\n");
}
const namesIn = (card: Card): string[] => {
  const text = [card.type === "fact" ? Object.values(card.fact).join(" ") : card.label, ...card.userPrompts, card.context].join("\n");
  return [...new Set(mentions(text, card.catalog.map((c) => ({ ...c, aliases: [], repositories: [] }))).map((m) => m.slug))];
};

async function askUntil<T>(t: Terminal, prompt: string, parse: (raw: string) => T | undefined): Promise<T | typeof QUIT> {
  for (;;) {
    const raw = (await t.ask(prompt)).trim();
    if (raw === QUIT) return QUIT;
    const value = parse(raw);
    if (value !== undefined) return value;
    t.print("  not understood, try again (q stops the sitting)");
  }
}
const confidence = (raw: string) => (raw === "s" ? "sure" as const : raw === "u" ? "unsure" as const : undefined);

async function labelFact(t: Terminal, card: FactCard): Promise<object | typeof QUIT> {
  const slugs = new Set(card.catalog.map((c) => c.slug));
  const owner = await askUntil(t, "owner (slug, none, ambiguous): ", (r) => (slugs.has(r) || r === "none" || r === "ambiguous" ? r : undefined));
  if (owner === QUIT) return QUIT;
  const roles: Record<string, Role> = {};
  for (const slug of namesIn(card)) {
    const role = await askUntil(t, `role of ${slug} (${ROLES.map((r, i) => `${i + 1} ${r}`).join(", ")}): `, (r) => ROLES[Number(r) - 1]);
    if (role === QUIT) return QUIT;
    roles[slug] = role;
  }
  const sure = await askUntil(t, "confidence (s/u): ", confidence);
  if (sure === QUIT) return QUIT;
  const note = (await t.ask("note (optional): ")).trim();
  return { owner, roles, confidence: sure, ...(note ? { note } : {}) };
}

async function askSlugs(t: Terminal, card: Card, prompt: string): Promise<string[] | typeof QUIT> {
  const slugs = new Set(card.catalog.map((c) => c.slug));
  return askUntil(t, prompt, (r) => { const l = slugList(r); return l.every((s) => slugs.has(s)) ? l : undefined; });
}
async function labelSession(t: Terminal, card: SessionCard): Promise<SessionLabel | typeof QUIT> {
  const relevant = await askSlugs(t, card, "relevant slugs (comma separated, blank for none): "); if (relevant === QUIT) return QUIT;
  const quotedInputOnly = await askSlugs(t, card, "names only inside quoted input (comma separated): "); if (quotedInputOnly === QUIT) return QUIT;
  const boilerplateOnly = await askSlugs(t, card, "names only in boilerplate/preamble (comma separated): "); if (boilerplateOnly === QUIT) return QUIT;
  const sure = await askUntil(t, "confidence (s/u): ", confidence); if (sure === QUIT) return QUIT;
  const note = (await t.ask("note (optional): ")).trim();
  return { relevant, quotedInputOnly, boilerplateOnly, confidence: sure, ...(note ? { note } : {}) };
}

/** One sitting: walk unlabelled cards in file order, saving after every card, stopping on q or at the time cap. */
export async function labelSitting(dir: string, cards: readonly Card[], t: Terminal, now: () => Date): Promise<{ labelled: number; remaining: number }> {
  const file = loadLabels(dir, "L1", SEED);
  const startedAt = now();
  const sitting = { startedAt: startedAt.toISOString(), endedAt: startedAt.toISOString(), cards: 0 };
  file.sittings.push(sitting);
  const todo = cards.filter((c) => !(c.id in file.labels));
  let done = 0;
  for (const card of todo) {
    t.print(`\n[${Object.keys(file.labels).length + 1}/${cards.length}] ${card.id}\n${show(card, false)}`);
    const label = card.type === "fact" ? await labelFact(t, card) : await labelSession(t, card);
    if (label === QUIT) break;
    file.labels[card.id] = validateLabel(card, label);
    done++; sitting.cards = done; sitting.endedAt = now().toISOString();
    saveLabels(dir, file);
    if ((now().getTime() - startedAt.getTime()) / 60_000 >= SITTING_MINUTES) { t.print(`\n${SITTING_MINUTES} minutes reached: stop here and resume in a new sitting.`); break; }
  }
  sitting.endedAt = now().toISOString();
  saveLabels(dir, file);
  return { labelled: done, remaining: todo.length - done };
}

/** Second look at session cards marked unsure: more source text, a fresh answer, and the final confidence. */
export async function adjudicate(dir: string, cards: readonly Card[], t: Terminal): Promise<number> {
  const file = loadLabels(dir, "L1", SEED);
  let n = 0;
  for (const card of cards) {
    const label = file.labels[card.id];
    if (card.type !== "session" || !label || !("relevant" in label) || label.confidence !== "unsure" || label.adjudicated) continue;
    t.print(`\n${card.id}\n${show(card, true)}`);
    const next = await labelSession(t, card);
    if (next === QUIT) break;
    const changed = [...next.relevant].sort().join() !== [...label.relevant].sort().join();
    file.labels[card.id] = validateLabel(card, { ...label, relevant: next.relevant, quotedInputOnly: next.quotedInputOnly, boilerplateOnly: next.boilerplateOnly, adjudicated: { changed, confidence: next.confidence } });
    saveLabels(dir, file); n++;
  }
  return n;
}
