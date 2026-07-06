import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadAliasMap, resetAliasMapCache } from "../../../../src/core/scope/alias-map.js";
import type { AliasMap } from "../../../../src/core/scope/alias-map.js";
import { deriveScope } from "../../../../src/core/scope/derive-scope.js";
import {
  scopeClause,
  scopeClauseSignal,
} from "../../../../src/core/scope/scope-clause.js";
import type { ActiveScope } from "../../../../src/core/scope/scope-clause.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMap(
  named: Record<string, string[]>,
  global: string[] = [],
): AliasMap {
  return {
    named: Object.entries(named).map(([scope, paths]) => ({ scope, paths })),
    global,
  };
}

// ---------------------------------------------------------------------------
// deriveScope: normalization
// ---------------------------------------------------------------------------

describe("deriveScope normalization", () => {
  const empty: AliasMap = { named: [], global: [] };

  it("returns null for an empty path", () => {
    expect(deriveScope("", empty)).toBeNull();
  });

  it("returns null for a relative path", () => {
    expect(deriveScope("relative/path", empty)).toBeNull();
    expect(deriveScope("./abs", empty)).toBeNull();
    expect(deriveScope("../foo", empty)).toBeNull();
  });

  it("returns the normalized path when there is no alias match", () => {
    const result = deriveScope("/abs/unknown-project", empty);
    expect(result).toBe("/abs/unknown-project");
  });

  it("strips a trailing slash from the input before returning the path", () => {
    const result = deriveScope("/abs/unknown-project/", empty);
    expect(result).toBe("/abs/unknown-project");
  });
});

// ---------------------------------------------------------------------------
// deriveScope: segment-boundary matching
// ---------------------------------------------------------------------------

describe("deriveScope segment boundary", () => {
  it("matches a configured prefix that equals the input exactly", () => {
    const map = makeMap({ "client-a": ["/abs/client-a"] });
    expect(deriveScope("/abs/client-a", map)).toBe("client-a");
  });

  it("matches a configured prefix that is a strict ancestor", () => {
    const map = makeMap({ "client-a": ["/abs/client-a"] });
    expect(deriveScope("/abs/client-a/src/index.ts", map)).toBe("client-a");
  });

  it("does NOT match when the input shares only the prefix text but not a segment boundary", () => {
    const map = makeMap({ "client-a": ["/abs/client-a"] });
    expect(deriveScope("/abs/client-abc/file", map)).toBe("/abs/client-abc/file");
    expect(deriveScope("/abs/client-ab", map)).toBe("/abs/client-ab");
  });
});

// ---------------------------------------------------------------------------
// deriveScope: longest match wins
// ---------------------------------------------------------------------------

describe("deriveScope longest match wins", () => {
  it("picks the more specific (longer) prefix when two entries overlap", () => {
    const map = makeMap({
      "project": ["/abs/workspace"],
      "client-a": ["/abs/workspace/client-a"],
    });
    expect(deriveScope("/abs/workspace/client-a/src", map)).toBe("client-a");
    expect(deriveScope("/abs/workspace/other", map)).toBe("project");
  });

  it("picks the named scope over global when they have equal-length prefixes", () => {
    const map = makeMap({ "client-a": ["/abs/shared"] }, ["/abs/shared"]);
    expect(deriveScope("/abs/shared/anything", map)).toBe("client-a");
  });
});

// ---------------------------------------------------------------------------
// deriveScope: named beats global on equal length (F7 nested-path precedence)
// ---------------------------------------------------------------------------

describe("deriveScope F7: client path under global root resolves to client scope", () => {
  it("resolves to the client scope even when it is nested inside a global root", () => {
    const map = makeMap(
      { "client-a": ["/abs/workspace/client-a"] },
      ["/abs/workspace"],
    );
    expect(deriveScope("/abs/workspace/client-a/file", map)).toBe("client-a");
  });

  it("falls through to global for a path under the global root but outside all named entries", () => {
    const map = makeMap(
      { "client-a": ["/abs/workspace/client-a"] },
      ["/abs/workspace"],
    );
    expect(deriveScope("/abs/workspace/other-project/file", map)).toBe("global");
  });
});

// ---------------------------------------------------------------------------
// deriveScope: global mapping
// ---------------------------------------------------------------------------

describe("deriveScope global mapping", () => {
  it("returns 'global' for a path under a global root", () => {
    const map: AliasMap = { named: [], global: ["/abs/global-root"] };
    expect(deriveScope("/abs/global-root/anything", map)).toBe("global");
  });

  it("returns 'global' for an exact match on a global root", () => {
    const map: AliasMap = { named: [], global: ["/abs/global-root"] };
    expect(deriveScope("/abs/global-root", map)).toBe("global");
  });
});

// ---------------------------------------------------------------------------
// deriveScope: symlink resolution (input and configured sides must agree)
// ---------------------------------------------------------------------------

describe("deriveScope symlink resolution", () => {
  let dir: string;
  let real: string;
  let link: string;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "nlm-scope-symlink-")));
    real = join(dir, "real-client-a");
    mkdirSync(join(real, "sub"), { recursive: true });
    link = join(dir, "link-to-a");
    symlinkSync(real, link);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("a symlinked input resolves to the scope of its real path", () => {
    const map = makeMap({ "client-a": [real] });
    expect(deriveScope(join(link, "sub"), map)).toBe("client-a");
  });

  it("a symlinked configured entry matches a real-path input (config side normalized too)", () => {
    resetAliasMapCache();
    const scopesPath = join(dir, "scopes.json");
    writeFileSync(scopesPath, JSON.stringify({ "client-a": [link] }));
    const map = loadAliasMap(scopesPath);
    resetAliasMapCache();
    expect(deriveScope(join(real, "sub"), map)).toBe("client-a");
  });
});

// ---------------------------------------------------------------------------
// deriveScope: alias collapse
// ---------------------------------------------------------------------------

describe("deriveScope alias collapse", () => {
  it("two different configured paths mapping to the same scope both resolve to that scope", () => {
    const map = makeMap({ "client-a": ["/abs/repo-one", "/abs/repo-two"] });
    expect(deriveScope("/abs/repo-one/src", map)).toBe("client-a");
    expect(deriveScope("/abs/repo-two/src", map)).toBe("client-a");
  });
});

// ---------------------------------------------------------------------------
// loadAliasMap: fail-open config handling
// ---------------------------------------------------------------------------

describe("loadAliasMap", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nlm-alias-map-"));
    resetAliasMapCache();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    resetAliasMapCache();
  });

  it("returns an empty map when the file does not exist (no throw)", () => {
    const map = loadAliasMap(join(dir, "nonexistent.json"));
    expect(map.named).toHaveLength(0);
    expect(map.global).toHaveLength(0);
  });

  it("returns an empty map for malformed JSON (no throw)", () => {
    const path = join(dir, "bad.json");
    writeFileSync(path, "not valid json {{{");
    const map = loadAliasMap(path);
    expect(map.named).toHaveLength(0);
    expect(map.global).toHaveLength(0);
  });

  it("parses named scopes and global roots correctly", () => {
    const path = join(dir, "scopes.json");
    writeFileSync(
      path,
      JSON.stringify({
        "client-a": ["/abs/client-a"],
        "client-b": ["/abs/client-b"],
        global: ["/abs/global"],
      }),
    );
    const map = loadAliasMap(path);
    expect(map.named).toHaveLength(2);
    const scopes = map.named.map((e) => e.scope).sort();
    expect(scopes).toEqual(["client-a", "client-b"]);
    expect(map.global).toEqual(["/abs/global"]);
  });

  it("caches after the first read and does not re-read on subsequent calls", () => {
    const path = join(dir, "scopes.json");
    writeFileSync(path, JSON.stringify({ "client-a": ["/abs/one"] }));
    const a = loadAliasMap(path);
    writeFileSync(path, JSON.stringify({ "client-b": ["/abs/two"] }));
    const b = loadAliasMap(path);
    expect(b).toBe(a);
  });

  it("re-reads after resetAliasMapCache", () => {
    const path = join(dir, "scopes.json");
    writeFileSync(path, JSON.stringify({ "client-a": ["/abs/one"] }));
    loadAliasMap(path);
    resetAliasMapCache();
    writeFileSync(path, JSON.stringify({ "client-b": ["/abs/two"] }));
    const fresh = loadAliasMap(path);
    expect(fresh.named.map((e) => e.scope)).toEqual(["client-b"]);
  });
});

// ---------------------------------------------------------------------------
// scopeClause: default variant
// ---------------------------------------------------------------------------

describe("scopeClause default variant", () => {
  it("scoped: produces a constraining fragment with the scope value AND global", () => {
    const result = scopeClause({ kind: "scoped", value: "client-a" });
    expect(result.sql).toBe("(scope = ? OR scope = 'global')");
    expect(result.params).toEqual(["client-a"]);
  });

  it("global-only: produces a constraining fragment for global rows only", () => {
    const result = scopeClause({ kind: "global-only" });
    expect(result.sql).toBe("(scope = 'global')");
    expect(result.params).toEqual([]);
  });

  it("all-scopes: produces a permissive fragment with no params", () => {
    const result = scopeClause({ kind: "all-scopes" });
    expect(result.sql).toBe("(1 = 1)");
    expect(result.params).toEqual([]);
  });

  it("scoped sql is non-empty and parenthesized (composable with AND)", () => {
    const { sql } = scopeClause({ kind: "scoped", value: "x" });
    expect(sql.startsWith("(")).toBe(true);
    expect(sql.endsWith(")")).toBe(true);
    expect(sql.length).toBeGreaterThan(2);
  });

  it("global-only sql is non-empty and parenthesized (composable with AND)", () => {
    const { sql } = scopeClause({ kind: "global-only" });
    expect(sql.startsWith("(")).toBe(true);
    expect(sql.endsWith(")")).toBe(true);
    expect(sql.length).toBeGreaterThan(2);
  });
});

// ---------------------------------------------------------------------------
// scopeClauseSignal: signal variant (no global arm)
// ---------------------------------------------------------------------------

describe("scopeClauseSignal signal variant", () => {
  it("scoped: no global arm; restricts to the named scope only", () => {
    const result = scopeClauseSignal({ kind: "scoped", value: "client-a" });
    expect(result.sql).toBe("(scope = ?)");
    expect(result.params).toEqual(["client-a"]);
    expect(result.sql).not.toContain("global");
  });

  it("global-only: matches nothing (fail-closed for signals)", () => {
    const result = scopeClauseSignal({ kind: "global-only" });
    expect(result.sql).toBe("(1 = 0)");
    expect(result.params).toEqual([]);
  });

  it("all-scopes: produces a permissive fragment with no params", () => {
    const result = scopeClauseSignal({ kind: "all-scopes" });
    expect(result.sql).toBe("(1 = 1)");
    expect(result.params).toEqual([]);
  });

  it("signal scoped sql is constraining and parenthesized", () => {
    const { sql, params } = scopeClauseSignal({ kind: "scoped", value: "x" });
    expect(sql.startsWith("(")).toBe(true);
    expect(sql.endsWith(")")).toBe(true);
    expect(params).toHaveLength(1);
  });

  it("signal global-only sql is constraining (returns nothing) and parenthesized", () => {
    const { sql, params } = scopeClauseSignal({ kind: "global-only" });
    expect(sql.startsWith("(")).toBe(true);
    expect(sql.endsWith(")")).toBe(true);
    expect(params).toHaveLength(0);
    expect(sql).toBe("(1 = 0)");
  });
});

// ---------------------------------------------------------------------------
// Type-level: ActiveScope exhaustiveness check (compile-time guard)
// ---------------------------------------------------------------------------

describe("ActiveScope type coverage", () => {
  it("accepts all three kinds without type errors", () => {
    const cases: ActiveScope[] = [
      { kind: "scoped", value: "any" },
      { kind: "global-only" },
      { kind: "all-scopes" },
    ];
    for (const c of cases) {
      expect(() => scopeClause(c)).not.toThrow();
      expect(() => scopeClauseSignal(c)).not.toThrow();
    }
  });
});
