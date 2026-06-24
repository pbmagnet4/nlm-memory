/** The minimal session view a topic provider sees. Extensions (e.g. NLOS) can
 *  key on entities and/or label to impose their own taxonomy. */
export interface TopicInput {
  readonly entities: ReadonlyArray<string>;
  readonly label: string;
  /** Resolved live-workstream label, when the session is bound. Takes precedence over entity/alias topics. */
  readonly workstreamLabel?: string;
}

export type TopicProvider = (input: TopicInput) => string;

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

/** NLM-core default: the session's first classified entity, normalized. */
export const defaultTopicProvider: TopicProvider = (input) => {
  const first = input.entities[0];
  return first && first.trim() ? normalize(first) : "uncategorized";
};

/** NLM-core: prefer the bound workstream's label; fall through to `fallback`
 *  (alias-map / first-entity) for unbound sessions. Retires the
 *  alphabetically-first-entity dependency for bound sessions (spec §10). */
export function workstreamTopicProvider(fallback: TopicProvider): TopicProvider {
  return (input) =>
    input.workstreamLabel && input.workstreamLabel.trim() ? input.workstreamLabel : fallback(input);
}

/** NLM-core optional: group entities into labels via an operator-supplied map.
 *  The same interface an extension uses to supply a function/taxonomy map. */
export function aliasTopicProvider(map: Record<string, string>): TopicProvider {
  const norm: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) norm[normalize(k)] = v;
  return (input) => {
    const base = defaultTopicProvider(input);
    return norm[base] ?? base;
  };
}
