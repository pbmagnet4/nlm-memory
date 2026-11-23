/**
 * Voice embed retry sweep (T2438 piece C, design §A invariant 3): the unit the
 * daemon ticks every 2 minutes. Unit-tested against a fake store so the
 * in-flight cap and the failure accounting are exercised without a database.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  VOICE_EMBED_SWEEP_BATCH,
  sweepVoiceEmbeddings,
  type VoiceEmbedSweepStore,
} from "../../../../src/core/voice/embed-sweep.js";
import type { WritingSampleMissing } from "../../../../src/ports/writing-sample-store.js";
import { resetForTests, tryAcquire } from "../../../../src/core/health/embed-inflight.js";

function fakeStore(rows: ReadonlyArray<WritingSampleMissing>): VoiceEmbedSweepStore & { upserted: string[] } {
  const upserted: string[] = [];
  return {
    upserted,
    async missingEmbeddings(_tenantId, limit) {
      return rows.slice(0, limit);
    },
    async upsertEmbedding(_tenantId, id) {
      upserted.push(id);
    },
  };
}

const embedder = (vector: (text: string) => Float32Array) => ({
  embed: async (text: string) => ({ vector: vector(text), model: "test-embedder" }),
});

describe("sweepVoiceEmbeddings", () => {
  beforeEach(() => resetForTests());

  it("repairs every row the store lists as missing a vector", async () => {
    const store = fakeStore([
      { id: "a1", text: "the first post" },
      { id: "b2", text: "the second post" },
    ]);

    const report = await sweepVoiceEmbeddings({
      tenantId: "team_local",
      store,
      embedder: embedder(() => new Float32Array(4)),
    });

    expect(report).toEqual({ attempted: 2, repaired: 2, failed: 0, shed: false });
    expect(store.upserted).toEqual(["a1", "b2"]);
  });

  it("embeds the stored text, so a repaired vector matches what ingest would have written", async () => {
    const embedded: string[] = [];
    const store = fakeStore([{ id: "a1", text: "Plain words, one idea." }]);

    await sweepVoiceEmbeddings({
      tenantId: "team_local",
      store,
      embedder: {
        embed: async (text: string) => {
          embedded.push(text);
          return { vector: new Float32Array(4), model: "test-embedder" };
        },
      },
    });

    expect(embedded).toEqual(["Plain words, one idea."]);
  });

  it("asks the store for the batch size the sweep is specified to use", async () => {
    const store = fakeStore([]);
    let askedFor = 0;
    store.missingEmbeddings = async (_tenantId, limit) => {
      askedFor = limit;
      return [];
    };

    await sweepVoiceEmbeddings({ tenantId: "team_local", store, embedder: embedder(() => new Float32Array(4)) });

    expect(askedFor).toBe(VOICE_EMBED_SWEEP_BATCH);
    expect(VOICE_EMBED_SWEEP_BATCH).toBe(8);
  });

  it("counts an embed failure without stopping the batch or writing a vector", async () => {
    const store = fakeStore([
      { id: "a1", text: "will fail" },
      { id: "b2", text: "will work" },
    ]);

    const report = await sweepVoiceEmbeddings({
      tenantId: "team_local",
      store,
      embedder: {
        embed: async (text: string) => {
          if (text === "will fail") throw new Error("embedder unreachable");
          return { vector: new Float32Array(4), model: "test-embedder" };
        },
      },
    });

    expect(report).toEqual({ attempted: 2, repaired: 1, failed: 1, shed: false });
    expect(store.upserted).toEqual(["b2"]);
  });

  it("sheds the rest of the batch when the shared embed cap is already saturated", async () => {
    const store = fakeStore([
      { id: "a1", text: "one" },
      { id: "b2", text: "two" },
    ]);
    for (let i = 0; i < 4; i++) expect(tryAcquire()).toBe(true);

    const report = await sweepVoiceEmbeddings({
      tenantId: "team_local",
      store,
      embedder: embedder(() => new Float32Array(4)),
    });

    expect(report).toEqual({ attempted: 0, repaired: 0, failed: 0, shed: true });
    expect(store.upserted).toEqual([]);
  });

  it("leaves the shared embed cap free for the next caller", async () => {
    tryAcquire();
    const report = await sweepVoiceEmbeddings({
      tenantId: "team_local",
      store: fakeStore([{ id: "a1", text: "one" }]),
      embedder: embedder(() => new Float32Array(4)),
    });

    expect(report).toEqual({ attempted: 1, repaired: 1, failed: 0, shed: false });
    expect(tryAcquire()).toBe(true);
  });

  it("reports a clean pass without touching the store when nothing is missing", async () => {
    const report = await sweepVoiceEmbeddings({
      tenantId: "team_local",
      store: fakeStore([]),
      embedder: embedder(() => new Float32Array(4)),
    });

    expect(report).toEqual({ attempted: 0, repaired: 0, failed: 0, shed: false });
  });
});
