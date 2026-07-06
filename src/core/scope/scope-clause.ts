export type ActiveScope =
  | { kind: "scoped"; value: string }
  | { kind: "global-only" }
  | { kind: "all-scopes" };

export function scopeClause(active: ActiveScope): { sql: string; params: string[] } {
  switch (active.kind) {
    case "scoped":
      return { sql: "(scope = ? OR scope = 'global')", params: [active.value] };
    case "global-only":
      return { sql: "(scope = 'global')", params: [] };
    case "all-scopes":
      return { sql: "(1 = 1)", params: [] };
  }
}

export function scopeClauseSignal(active: ActiveScope): { sql: string; params: string[] } {
  switch (active.kind) {
    case "scoped":
      return { sql: "(scope = ?)", params: [active.value] };
    case "global-only":
      return { sql: "(1 = 0)", params: [] };
    case "all-scopes":
      return { sql: "(1 = 1)", params: [] };
  }
}
