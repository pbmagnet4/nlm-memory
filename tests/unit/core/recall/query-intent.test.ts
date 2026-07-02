import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyQueryIntent } from "../../../../src/core/recall/query-intent.js";
import { logQuery } from "../../../../src/core/recall/query-log.js";

// --- classifier unit tests ---

describe("classifyQueryIntent", () => {
  it('returns "other" for empty string', () => {
    expect(classifyQueryIntent("")).toBe("other");
  });

  it('returns "other" for whitespace-only', () => {
    expect(classifyQueryIntent("   ")).toBe("other");
  });

  describe("relational patterns", () => {
    it('matches "depends on"', () => {
      expect(classifyQueryIntent("what does the auth module depends on")).toBe("relational");
    });

    it('matches "related to"', () => {
      expect(classifyQueryIntent("sessions related to the postgres migration")).toBe("relational");
    });

    it('matches "connected to"', () => {
      expect(classifyQueryIntent("which services are connected to the gateway")).toBe("relational");
    });

    it('matches "connected with"', () => {
      expect(classifyQueryIntent("nodes connected with the embedding layer")).toBe("relational");
    });

    it('matches "what uses"', () => {
      expect(classifyQueryIntent("what uses the recall service")).toBe("relational");
    });

    it('matches "downstream of"', () => {
      expect(classifyQueryIntent("components downstream of the ingest pipeline")).toBe("relational");
    });

    it("is case-insensitive", () => {
      expect(classifyQueryIntent("What DEPENDS ON the session store")).toBe("relational");
    });
  });

  describe("temporal patterns", () => {
    it('matches "last week" style queries', () => {
      expect(classifyQueryIntent("what did we decide last week")).toBe("temporal");
    });

    it('matches "days ago" style queries', () => {
      expect(classifyQueryIntent("what happened 3 days ago with the deploy")).toBe("temporal");
    });

    it('matches "when did" queries', () => {
      expect(classifyQueryIntent("when did I set up the Postgres connection")).toBe("temporal");
    });

    it('matches "yesterday" queries', () => {
      expect(classifyQueryIntent("what was the plan yesterday")).toBe("temporal");
    });
  });

  describe("relational takes priority over temporal", () => {
    it("relational + temporal -> relational", () => {
      expect(classifyQueryIntent("what did I change last week that depends on the DB")).toBe(
        "relational",
      );
    });
  });

  describe("lookup (default)", () => {
    it("plain keyword query", () => {
      expect(classifyQueryIntent("pgvector sqlite recall")).toBe("lookup");
    });

    it("named entity query", () => {
      expect(classifyQueryIntent("Qdrant embedding backfill")).toBe("lookup");
    });

    it("question without relational or temporal markers", () => {
      expect(classifyQueryIntent("what is the default embedding model")).toBe("lookup");
    });
  });
});

// --- integration: logQuery writes intent field ---

describe("logQuery intent field", () => {
  let dir: string;
  let logPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nlm-qi-"));
    logPath = join(dir, "query_log.jsonl");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes intent=lookup for a plain keyword query", async () => {
    await logQuery(
      {
        source: "test",
        runtime: null,
        query: "pgvector migration",
        entity: null,
        kind: null,
        mode: "keyword",
        limit: 5,
        nResults: 1,
        returnedIds: ["s1"],
      },
      logPath,
    );
    expect(existsSync(logPath)).toBe(true);
    const entry = JSON.parse(readFileSync(logPath, "utf8").trim());
    expect(entry.intent).toBe("lookup");
  });

  it("writes intent=temporal for a time-anchored query", async () => {
    await logQuery(
      {
        source: "test",
        runtime: null,
        query: "what happened last week with the deploy",
        entity: null,
        kind: null,
        mode: "keyword",
        limit: 5,
        nResults: 0,
        returnedIds: [],
      },
      logPath,
    );
    const entry = JSON.parse(readFileSync(logPath, "utf8").trim());
    expect(entry.intent).toBe("temporal");
  });

  it("writes intent=relational for a dependency query", async () => {
    await logQuery(
      {
        source: "test",
        runtime: null,
        query: "modules related to the embedding pipeline",
        entity: null,
        kind: null,
        mode: "keyword",
        limit: 5,
        nResults: 0,
        returnedIds: [],
      },
      logPath,
    );
    const entry = JSON.parse(readFileSync(logPath, "utf8").trim());
    expect(entry.intent).toBe("relational");
  });

  it("writes intent=other for a null query", async () => {
    await logQuery(
      {
        source: "test",
        runtime: null,
        query: null,
        entity: "SomeEntity",
        kind: null,
        mode: "keyword",
        limit: 5,
        nResults: 0,
        returnedIds: [],
      },
      logPath,
    );
    const entry = JSON.parse(readFileSync(logPath, "utf8").trim());
    expect(entry.intent).toBe("other");
  });
});
