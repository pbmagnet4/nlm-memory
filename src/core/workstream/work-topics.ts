// src/core/workstream/work-topics.ts
import { normalizeLabel } from "./model.js";

export interface WorkTopic {
  readonly label: string;
  readonly entities: ReadonlyArray<string>;
}

export function parseWorkTopics(raw: unknown): ReadonlyArray<WorkTopic> {
  if (Array.isArray(raw)) {
    return raw.map((t) => {
      if (
        !t ||
        typeof t !== "object" ||
        typeof (t as { label?: unknown }).label !== "string" ||
        !Array.isArray((t as { entities?: unknown }).entities)
      ) {
        throw new Error(
          `work-topics: array item is not {label, entities[]}: ${JSON.stringify(t)}`,
        );
      }
      return {
        label: (t as { label: string }).label,
        entities: ((t as { entities: unknown[] }).entities).map(String),
      };
    });
  }
  if (raw && typeof raw === "object") {
    const entries = Object.entries(raw as Record<string, unknown>);
    // Alias-map shape { "<alias>": "<canonical>" }: group aliases under their
    // canonical label. Canonical = workstream label; aliases (+ the canonical itself)
    // = its entities.
    if (entries.length > 0 && entries.every(([, v]) => typeof v === "string")) {
      const byCanonical = new Map<string, Set<string>>();
      for (const [alias, canonical] of entries as Array<[string, string]>) {
        const set = byCanonical.get(canonical) ?? new Set<string>([canonical]);
        set.add(alias);
        byCanonical.set(canonical, set);
      }
      return [...byCanonical].map(([label, entities]) => ({ label, entities: [...entities] }));
    }
    // Label-to-entities map { "<label>": ["<entity>", ...] }.
    return entries.map(([label, ents]) => {
      if (!Array.isArray(ents)) {
        throw new Error(`work-topics: value for "${label}" is neither a string (alias map) nor an array (entity map)`);
      }
      return { label, entities: ents.map(String) };
    });
  }
  throw new Error("work-topics: expected an object map or an array of {label, entities[]}");
}

/**
 * Build a map from normalized alias -> canonical label for all topics.
 * Used by the binding path to resolve classifier output through aliases.
 */
export function aliasToLabelMap(topics: ReadonlyArray<WorkTopic>): Map<string, string> {
  const out = new Map<string, string>();
  for (const topic of topics) {
    for (const entity of topic.entities) {
      out.set(normalizeLabel(entity), topic.label);
    }
  }
  return out;
}
