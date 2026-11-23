/**
 * Backend-agnostic contract for the WritingSampleStore port (T2438 piece A).
 * Integration tests supply a harness with a fresh, migrated, empty Storage
 * whose voice lane stamps a pinned install scope.
 */

import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Storage } from "../../src/ports/storage.js";
import type { WritingSampleInput } from "../../src/ports/writing-sample-store.js";
import {
  normaliseWritingText,
  writingSampleId,
  writingTextHash,
} from "../../src/core/storage/sqlite-writing-sample-store.js";

const TENANT = "team_local";
const FOREIGN = "team_foreign";
const QUERY = new Float32Array(768);

/** A vector whose L2 distance from {@link QUERY} is exactly `distance`. */
function vector(distance: number): Float32Array {
  const v = new Float32Array(768);
  v[0] = distance;
  return v;
}

function makeSample(overrides: Partial<WritingSampleInput> = {}): WritingSampleInput {
  return {
    voice: "edward",
    channel: "linkedin",
    source: "published",
    text: "I shipped the daemon on a Tuesday and it stayed up.",
    outcome: "published",
    ts: "2026-11-20T09:00:00.000Z",
    ...overrides,
  };
}

export interface WritingSampleStoreContractHarness {
  readonly name: string;
  /** The scope the storage under test was built to stamp. */
  readonly installScope: string;
  setup(): Promise<Storage>;
  teardown(storage: Storage): Promise<void>;
  /** Register a tenant so both backends accept its rows. */
  ensureTeam(storage: Storage, teamId: string): Promise<void>;
  /**
   * Direct row probe. The port deliberately never echoes install_scope or
   * text_hash, so the two things a caller must be able to trust — what the
   * server stamped — are asserted below the port.
   */
  rawSample(storage: Storage, id: string): Promise<{ install_scope: string; text_hash: string; tenant_id: string } | null>;
}

export function runWritingSampleStoreContract(h: WritingSampleStoreContractHarness): void {
  describe(`WritingSampleStore contract: ${h.name}`, () => {
    let storage: Storage;

    beforeEach(async () => {
      storage = await h.setup();
      await h.ensureTeam(storage, TENANT);
      await h.ensureTeam(storage, FOREIGN);
    });
    afterEach(async () => {
      await h.teardown(storage);
    });

    it("stores a sample and reports it as new", async () => {
      const { id, skipped } = await storage.writingSamples.insert(TENANT, makeSample());
      expect(skipped).toBe(false);
      expect(id).toMatch(/^[0-9a-f]{16}$/);
      expect(await h.rawSample(storage, id)).not.toBeNull();
    });

    it("re-inserting the same sample is skipped on the same id", async () => {
      const first = await storage.writingSamples.insert(TENANT, makeSample());
      const second = await storage.writingSamples.insert(TENANT, makeSample());
      expect(second.id).toBe(first.id);
      expect(second.skipped).toBe(true);
    });

    it("derives the id from tenant_id|install_scope|voice|channel|text_hash|source", async () => {
      const input = makeSample({ audience: "client-blog", sourceRef: "https://example.test/post" });
      const { id } = await storage.writingSamples.insert(TENANT, input);
      const textHash = createHash("sha256")
        .update(input.text.trim().replace(/\s+/g, " ").toLowerCase())
        .digest("hex");
      expect(id).toBe(
        writingSampleId({
          tenantId: TENANT,
          installScope: h.installScope,
          voice: input.voice,
          channel: input.channel,
          textHash,
          source: input.source,
        }),
      );
    });

    it("dedups per tenant: the same post in two tenants is two rows, each visible only to its owner", async () => {
      const input = makeSample({ text: "one post, two tenants" });
      const mine = await storage.writingSamples.insert(TENANT, input);
      const theirs = await storage.writingSamples.insert(FOREIGN, input);
      expect(mine.skipped).toBe(false);
      expect(theirs.skipped).toBe(false);
      expect(theirs.id).not.toBe(mine.id);
      expect((await storage.writingSamples.missingEmbeddings(TENANT, 10)).map((r) => r.id)).toContain(mine.id);
      expect((await storage.writingSamples.missingEmbeddings(TENANT, 10)).map((r) => r.id)).not.toContain(theirs.id);
      expect((await storage.writingSamples.missingEmbeddings(FOREIGN, 10)).map((r) => r.id)).toEqual([theirs.id]);
      expect((await storage.writingSamples.insert(FOREIGN, input)).skipped).toBe(true);
    });

    it("treats the same post seen under two sources as two rows", async () => {
      const published = await storage.writingSamples.insert(TENANT, makeSample({ source: "published", outcome: "published" }));
      const approved = await storage.writingSamples.insert(TENANT, makeSample({ source: "approved", outcome: "approved" }));
      expect(approved.id).not.toBe(published.id);
      expect(approved.skipped).toBe(false);
    });

    it("normalises text_hash by trimming, collapsing whitespace and lowercasing", async () => {
      const messy = "  I   Shipped the DAEMON\n  on a Tuesday and it stayed up. ";
      const clean = "i shipped the daemon on a tuesday and it stayed up.";
      const { id } = await storage.writingSamples.insert(TENANT, makeSample({ text: messy }));
      const again = await storage.writingSamples.insert(TENANT, makeSample({ text: clean }));

      expect(again.id).toBe(id);
      expect(again.skipped).toBe(true);
      const row = await h.rawSample(storage, id);
      // The design's normalisation, spelled out here so the helper is not
      // proving itself.
      const expectedHash = createHash("sha256")
        .update(messy.trim().replace(/\s+/g, " ").toLowerCase())
        .digest("hex");
      expect(row?.text_hash).toBe(expectedHash);
      expect(normaliseWritingText(messy)).toBe(clean);
      expect(writingTextHash(clean)).toBe(expectedHash);
    });

    it("searches empty-handed while no sample has a vector yet", async () => {
      await storage.writingSamples.insert(TENANT, makeSample());
      expect(
        await storage.writingSamples.search(TENANT, QUERY, {
          voice: "edward",
          outcomes: ["published", "approved"],
          k: 3,
        }),
      ).toEqual([]);
    });

    it("stamps install_scope and tenant_id server-side", async () => {
      const { id } = await storage.writingSamples.insert(TENANT, makeSample());
      const row = await h.rawSample(storage, id);
      expect(row?.install_scope).toBe(h.installScope);
      expect(row?.tenant_id).toBe(TENANT);
    });

    it("lists only the rows still missing a vector, up to the limit", async () => {
      const a = await storage.writingSamples.insert(TENANT, makeSample({ text: "alpha post" }));
      const b = await storage.writingSamples.insert(TENANT, makeSample({ text: "beta post" }));
      const c = await storage.writingSamples.insert(TENANT, makeSample({ text: "gamma post" }));
      await storage.writingSamples.upsertEmbedding(TENANT, b.id, vector(1));

      const missing = await storage.writingSamples.missingEmbeddings(TENANT, 10);
      expect(missing.map((m) => m.id).sort()).toEqual([a.id, c.id].sort());
      expect(missing.find((m) => m.id === a.id)?.text).toBe("alpha post");

      expect(await storage.writingSamples.missingEmbeddings(TENANT, 1)).toHaveLength(1);
      // A non-positive limit never means "the whole corpus".
      expect(await storage.writingSamples.missingEmbeddings(TENANT, 0)).toEqual([]);
    });

    it("ignores an embedding write for another tenant's sample", async () => {
      const { id } = await storage.writingSamples.insert(TENANT, makeSample());
      await storage.writingSamples.upsertEmbedding(FOREIGN, id, vector(0));
      const foreignMissing = await storage.writingSamples.missingEmbeddings(FOREIGN, 10);
      expect(foreignMissing.map((m) => m.id)).not.toContain(id);
      expect((await storage.writingSamples.missingEmbeddings(TENANT, 10)).map((m) => m.id)).toContain(id);
    });

    it("searches by voice, channel, outcome and k", async () => {
      const seed = async (overrides: Partial<WritingSampleInput>, distance: number) => {
        const { id } = await storage.writingSamples.insert(TENANT, makeSample(overrides));
        await storage.writingSamples.upsertEmbedding(TENANT, id, vector(distance));
        return id;
      };
      const linkedinNear = await seed({ text: "near linkedin post" }, 1);
      const linkedinFar = await seed({ text: "far linkedin post" }, 2);
      const email = await seed({ text: "an email I approved", channel: "email-professional", source: "approved", outcome: "approved" }, 0.5);
      const rejected = await seed({ text: "a draft I threw away", source: "approved", outcome: "rejected" }, 0.2);
      const otherVoice = await seed({ text: "someone else writes like this", voice: "muse", source: "approved", outcome: "approved" }, 0.1);

      const search = (overrides: { voice?: string; channel?: string; outcomes?: readonly ("published" | "approved" | "rejected" | "pending_review")[]; k?: number } = {}) =>
        storage.writingSamples.search(TENANT, QUERY, {
          voice: overrides.voice ?? "edward",
          ...(overrides.channel !== undefined ? { channel: overrides.channel } : {}),
          outcomes: overrides.outcomes ?? ["published", "approved"],
          k: overrides.k ?? 5,
        });

      const linkedin = await search({ channel: "linkedin" });
      expect(linkedin.map((hit) => hit.id)).toEqual([linkedinNear, linkedinFar]);
      expect(linkedin[0]!.distance).toBeCloseTo(1, 5);
      expect(linkedin[0]!.text).toBe("near linkedin post");
      expect(linkedin[0]!.source).toBe("published");
      expect(linkedin[0]!.ts).toBe("2026-11-20T09:00:00.000Z");
      expect(linkedin.some((hit) => hit.id === email)).toBe(false);

      // Channel omitted: every channel of the voice, nearest first.
      expect((await search()).map((hit) => hit.id)).toEqual([email, linkedinNear, linkedinFar]);
      expect((await search({ k: 1 })).map((hit) => hit.id)).toEqual([email]);
      expect((await search({ voice: "muse" })).map((hit) => hit.id)).toEqual([otherVoice]);
      expect((await search({ outcomes: ["rejected"] })).map((hit) => hit.id)).toEqual([rejected]);
      expect(await search({ outcomes: [] })).toEqual([]);
    });

    it("keeps one tenant's samples out of another tenant's search", async () => {
      const mine = await storage.writingSamples.insert(TENANT, makeSample({ text: "my own words" }));
      await storage.writingSamples.upsertEmbedding(TENANT, mine.id, vector(1));
      const theirs = await storage.writingSamples.insert(FOREIGN, makeSample({ text: "their words" }));
      await storage.writingSamples.upsertEmbedding(FOREIGN, theirs.id, vector(0.1));

      const asMine = await storage.writingSamples.search(TENANT, QUERY, {
        voice: "edward",
        outcomes: ["published", "approved", "rejected", "pending_review"],
        k: 5,
      });
      expect(asMine.map((hit) => hit.id)).toEqual([mine.id]);

      const asTheirs = await storage.writingSamples.search(FOREIGN, QUERY, {
        voice: "edward",
        outcomes: ["published", "approved", "rejected", "pending_review"],
        k: 5,
      });
      expect(asTheirs.map((hit) => hit.id)).toEqual([theirs.id]);
    });

    it("reads the newest samples first, with no vector and no distance", async () => {
      const old = await storage.writingSamples.insert(TENANT, makeSample({ text: "an older post", ts: "2026-11-18T09:00:00.000Z" }));
      const mid = await storage.writingSamples.insert(TENANT, makeSample({ text: "a middle post", ts: "2026-11-19T09:00:00.000Z" }));
      const fresh = await storage.writingSamples.insert(TENANT, makeSample({ text: "the newest post", ts: "2026-11-20T09:00:00.000Z" }));

      const rows = await storage.writingSamples.latest(TENANT, {
        voice: "edward",
        channel: "linkedin",
        outcomes: ["published"],
        k: 5,
      });
      expect(rows.map((hit) => hit.id)).toEqual([fresh.id, mid.id, old.id]);
      expect(rows.every((hit) => hit.distance === null)).toBe(true);
      expect(rows[0]!.text).toBe("the newest post");
      expect(rows[0]!.ts).toBe("2026-11-20T09:00:00.000Z");
      // No embedding needed: the newest read works on a vectorless corpus.
      expect(await storage.writingSamples.missingEmbeddings(TENANT, 10)).toHaveLength(3);
    });

    it("filters latest by channel, outcome and k", async () => {
      const seed = async (overrides: Partial<WritingSampleInput>, ts: string) =>
        (await storage.writingSamples.insert(TENANT, makeSample({ ...overrides, ts }))).id;
      const newest = await seed({ text: "newest linkedin post" }, "2026-11-20T09:00:00.000Z");
      const older = await seed({ text: "older linkedin post" }, "2026-11-19T09:00:00.000Z");
      const email = await seed(
        { text: "a newer email", channel: "email-professional", source: "approved", outcome: "approved" },
        "2026-11-21T09:00:00.000Z",
      );
      const rejected = await seed(
        { text: "a rejected draft", source: "approved", outcome: "rejected" },
        "2026-11-22T09:00:00.000Z",
      );

      const latest = (overrides: { channel?: string; outcomes?: readonly ("published" | "approved" | "rejected" | "pending_review")[]; k?: number } = {}) =>
        storage.writingSamples.latest(TENANT, {
          voice: "edward",
          ...(overrides.channel !== undefined ? { channel: overrides.channel } : {}),
          outcomes: overrides.outcomes ?? ["published"],
          k: overrides.k ?? 5,
        });

      expect((await latest({ channel: "linkedin" })).map((hit) => hit.id)).toEqual([newest, older]);
      expect((await latest({ channel: "linkedin", k: 1 })).map((hit) => hit.id)).toEqual([newest]);
      expect((await latest({ channel: "email-professional", outcomes: ["approved"] })).map((hit) => hit.id)).toEqual([email]);
      expect((await latest({ channel: "linkedin", outcomes: ["rejected"] })).map((hit) => hit.id)).toEqual([rejected]);
      expect((await latest({ channel: "linkedin", outcomes: ["approved"] })).map((hit) => hit.id)).toEqual([]);
      expect(await latest({ outcomes: [] })).toEqual([]);
    });

    it("keeps one tenant's samples out of another tenant's latest", async () => {
      const mine = await storage.writingSamples.insert(
        TENANT,
        makeSample({ text: "my own words", ts: "2026-11-20T09:00:00.000Z" }),
      );
      await storage.writingSamples.insert(
        FOREIGN,
        makeSample({ text: "their words", ts: "2026-11-21T09:00:00.000Z" }),
      );

      const asMine = await storage.writingSamples.latest(TENANT, {
        voice: "edward",
        channel: "linkedin",
        outcomes: ["published"],
        k: 5,
      });
      expect(asMine.map((hit) => hit.id)).toEqual([mine.id]);

      const asTheirs = await storage.writingSamples.latest(FOREIGN, {
        voice: "edward",
        channel: "linkedin",
        outcomes: ["published"],
        k: 5,
      });
      expect(asTheirs).toHaveLength(1);
      expect(asTheirs[0]!.id).not.toBe(mine.id);
    });
  });
}
