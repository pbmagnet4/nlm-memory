import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ClassifierCache,
  type ClassifierClient,
} from "../../../scripts/longmemeval/classifier-cache.js";
import type { ClassifyResult } from "../../../src/ports/llm-client.js";

const PROVIDER = "ollama";
const MODEL = "test-model:latest";

function makeResult(label: string): ClassifyResult {
  return {
    label,
    summary: "test summary",
    entities: ["entity-a", "entity-b"],
    decisions: ["decision-1"],
    open: ["open-q-1"],
    confidence: 0.9,
    facts: [],
  };
}

class StubClient implements ClassifierClient {
  public calls = 0;
  constructor(private readonly responder: (body: string) => Promise<ClassifyResult>) {}
  async classify(body: string): Promise<ClassifyResult> {
    this.calls++;
    return this.responder(body);
  }
}

class ThrowingClient implements ClassifierClient {
  public calls = 0;
  constructor(private readonly error: Error) {}
  async classify(): Promise<ClassifyResult> {
    this.calls++;
    throw this.error;
  }
}

describe("ClassifierCache", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nlm-clf-cache-"));
    dbPath = join(dir, "classifier.sqlite");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("calls the client on first lookup and caches the result", async () => {
    const client = new StubClient(async (body) => makeResult(`label-for-${body.slice(0, 4)}`));
    const cache = new ClassifierCache({ dbPath, provider: PROVIDER, model: MODEL, client });
    try {
      const a = await cache.classify("body-aaaa");
      expect(client.calls).toBe(1);
      expect(a.failed).toBe(false);
      expect(a.result?.label).toBe("label-for-body");
      expect(a.elapsedMs).toBeGreaterThanOrEqual(0);
    } finally {
      cache.close();
    }
  });

  it("returns the cached result without re-calling the client on second lookup", async () => {
    const client = new StubClient(async () => makeResult("once"));
    const cache = new ClassifierCache({ dbPath, provider: PROVIDER, model: MODEL, client });
    try {
      await cache.classify("body-1");
      await cache.classify("body-1");
      await cache.classify("body-1");
      expect(client.calls).toBe(1);
    } finally {
      cache.close();
    }
  });

  it("stores failures as failed=true and does not retry", async () => {
    const client = new ThrowingClient(new Error("model unhappy"));
    const cache = new ClassifierCache({ dbPath, provider: PROVIDER, model: MODEL, client });
    try {
      const first = await cache.classify("body-bad");
      expect(first.failed).toBe(true);
      expect(first.error).toContain("model unhappy");
      expect(first.result).toBeNull();
      const second = await cache.classify("body-bad");
      expect(second.failed).toBe(true);
      expect(client.calls).toBe(1);
    } finally {
      cache.close();
    }
  });

  it("scopes cache entries by (provider, model, body) — same body / different model is a miss", async () => {
    const responder = async (body: string) => makeResult(`L-${body}`);
    const clientA = new StubClient(responder);
    const clientB = new StubClient(responder);
    const cacheA = new ClassifierCache({ dbPath, provider: PROVIDER, model: "model-a", client: clientA });
    const cacheB = new ClassifierCache({ dbPath, provider: PROVIDER, model: "model-b", client: clientB });
    try {
      await cacheA.classify("same-body");
      await cacheB.classify("same-body");
      expect(clientA.calls).toBe(1);
      expect(clientB.calls).toBe(1);
      // Re-hit the first model — still 1 call.
      await cacheA.classify("same-body");
      expect(clientA.calls).toBe(1);
    } finally {
      cacheA.close();
      cacheB.close();
    }
  });

  it("persists across cache instances on the same db", async () => {
    const responder = async () => makeResult("persisted");
    const first = new ClassifierCache({
      dbPath,
      provider: PROVIDER,
      model: MODEL,
      client: new StubClient(responder),
    });
    await first.classify("body-persist");
    first.close();

    const second = new ClassifierCache({
      dbPath,
      provider: PROVIDER,
      model: MODEL,
      client: new StubClient(async () => {
        throw new Error("should not be called");
      }),
    });
    try {
      const entry = await second.classify("body-persist");
      expect(entry.failed).toBe(false);
      expect(entry.result?.label).toBe("persisted");
    } finally {
      second.close();
    }
  });

  it("stats() reports ok and failure counts scoped to the (provider, model)", async () => {
    const okClient = new StubClient(async () => makeResult("ok"));
    const badClient = new ThrowingClient(new Error("nope"));
    const okCache = new ClassifierCache({ dbPath, provider: PROVIDER, model: "ok-model", client: okClient });
    const badCache = new ClassifierCache({ dbPath, provider: PROVIDER, model: "bad-model", client: badClient });
    try {
      await okCache.classify("a");
      await okCache.classify("b");
      await badCache.classify("c");
      await badCache.classify("d");
      await badCache.classify("e");

      const okStats = okCache.stats();
      expect(okStats.total).toBe(2);
      expect(okStats.ok).toBe(2);
      expect(okStats.failed).toBe(0);

      const badStats = badCache.stats();
      expect(badStats.total).toBe(3);
      expect(badStats.ok).toBe(0);
      expect(badStats.failed).toBe(3);
    } finally {
      okCache.close();
      badCache.close();
    }
  });

  it("propagates non-Error throws as string error messages", async () => {
    class WeirdClient implements ClassifierClient {
      async classify(): Promise<ClassifyResult> {
        // simulate a throw of something that isn't an Error
        throw "raw string thrown" as unknown as Error;
      }
    }
    const cache = new ClassifierCache({ dbPath, provider: PROVIDER, model: MODEL, client: new WeirdClient() });
    try {
      const r = await cache.classify("body-weird");
      expect(r.failed).toBe(true);
      expect(r.error).toContain("raw string thrown");
    } finally {
      cache.close();
    }
  });
});

// Silence vitest's unused-imports lint if vi turns out not to be needed.
void vi;
