/**
 * recall-voice — voice recall lane (T2438 piece D).
 *
 * Against a real SqliteStorage (mkdtemp) with a deterministic fake embedder
 * (vectors the test controls) and a temp rules dir: tiering, channel
 * fallback, the avoid band, the no-embedder newest-first fallback, rules
 * null/present, maxChars trimming order, tenant isolation of `latest`, and
 * the empty-corpus empty result.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recallVoice } from "../../../../src/core/voice/recall-voice.js";
import { LLMUnreachableError, type LLMClient } from "../../../../src/ports/llm-client.js";
import type { WritingSampleInput } from "../../../../src/ports/writing-sample-store.js";
import { SqliteStorage } from "../../../../src/core/storage/sqlite-storage.js";

const MIGRATIONS_DIR = resolve("migrations");
const INSTALL_SCOPE = "install-voice-test";
const TENANT = "team_local";
const FOREIGN = "team_foreign";
const QUERY = new Float32Array(768);

/** A vector whose L2 distance from QUERY is exactly `distance`. */
function vector(distance: number): Float32Array {
  const v = new Float32Array(768);
  v[0] = distance;
  return v;
}

const embedderState = { unreachable: false };

function fakeEmbedder(): LLMClient {
  return {
    async embed() {
      if (embedderState.unreachable) throw new LLMUnreachableError("fake", new Error("down"));
      return { vector: QUERY, model: "fake" };
    },
    async classify() { throw new Error("unused"); },
    async nameWorkstream() { return null; },
    async rewriteForRecall() { return { keywordQuery: "", semanticQuery: "" }; },
  };
}

let storage: SqliteStorage;
let dir: string;
const rulesDirs: string[] = [];
let prevRulesDir: string | undefined;

function tmpRulesDir(): string {
  const d = mkdtempSync(join(tmpdir(), "nlm-voice-recall-"));
  rulesDirs.push(d);
  return d;
}

function seed(overrides: Partial<WritingSampleInput> & { distance: number; ts?: string }): Promise<string> {
  const { distance, ts, ...rest } = overrides;
  return storage.writingSamples
    .insert(TENANT, {
      voice: "edward",
      channel: "linkedin",
      source: "published",
      outcome: "published",
      text: "default text",
      ts: ts ?? "2026-11-20T09:00:00.000Z",
      ...rest,
    })
    .then(async ({ id }) => {
      await storage.writingSamples.upsertEmbedding(TENANT, id, vector(distance));
      return id;
    });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "nlm-voice-recall-"));
  embedderState.unreachable = false;
  prevRulesDir = process.env["NLM_VOICE_RULES_DIR"];
  delete process.env["NLM_VOICE_RULES_DIR"];
  storage = SqliteStorage.create({
    dbPath: join(dir, "corpus.sqlite"),
    migrationsDir: MIGRATIONS_DIR,
    installScopeProvider: () => INSTALL_SCOPE,
  });
  for (const team of [TENANT, FOREIGN]) {
    storage.rawDb().prepare("INSERT OR IGNORE INTO teams (id, name) VALUES (?, ?)").run(team, team);
  }
});

afterEach(async () => {
  await storage.close();
  rmSync(dir, { recursive: true, force: true });
  while (rulesDirs.length) rmSync(rulesDirs.pop()!, { recursive: true, force: true });
  if (prevRulesDir === undefined) delete process.env["NLM_VOICE_RULES_DIR"];
  else process.env["NLM_VOICE_RULES_DIR"] = prevRulesDir;
});

describe("recallVoice: tiering and scope", () => {
  it("never lets a near approved sample displace a published one beyond the k-th slot", async () => {
    await seed({ text: "approved a", distance: 0.1, source: "approved", outcome: "approved" });
    await seed({ text: "approved b", distance: 0.2, source: "approved", outcome: "approved" });
    await seed({ text: "approved c", distance: 0.3, source: "approved", outcome: "approved" });
    const p1 = await seed({ text: "published one", distance: 4 });
    const p2 = await seed({ text: "published two", distance: 5 });
    const result = await recallVoice(
      { writingSamples: storage.writingSamples, embedClient: fakeEmbedder() },
      TENANT,
      { voice: "edward", channel: "linkedin", request: "a post about the daemon", k: 3 },
    );
    expect(result.examples.slice(0, 2).map((e) => e.id)).toEqual([p1, p2]);
    expect(result.examples[2]!.outcome).toBe("approved");
    expect(result.examples).toHaveLength(3);
  });

  it("ranks published before approved, then by distance", async () => {
    const approvedNear = await seed({ text: "approved near", distance: 1, source: "approved", outcome: "approved" });
    const publishedFar = await seed({ text: "published far", distance: 5 });
    const result = await recallVoice(
      { writingSamples: storage.writingSamples, embedClient: fakeEmbedder() },
      TENANT,
      { voice: "edward", channel: "linkedin", request: "a post about the daemon" },
    );
    expect(result.examples.map((e) => e.id)).toEqual([publishedFar, approvedNear]);
    expect(result.examples[0]!.outcome).toBe("published");
    expect(result.examples[0]!.distance).toBeCloseTo(5, 5);
    expect(result.examples[1]!.distance).toBeCloseTo(1, 5);
  });

  it("fills from the voice's other channels when the channel has fewer than k", async () => {
    const local = await seed({ text: "the linkedin post", distance: 1 });
    const emailNear = await seed({ text: "an email", distance: 2, channel: "email-professional", source: "approved", outcome: "approved" });
    const emailFar = await seed({ text: "another email", distance: 3, channel: "email-professional" });
    const result = await recallVoice(
      { writingSamples: storage.writingSamples, embedClient: fakeEmbedder() },
      TENANT,
      { voice: "edward", channel: "linkedin", request: "a post", k: 3 },
    );
    // The requested channel first, then the other channels tiered the same
    // way: published before approved, then by distance.
    expect(result.examples.map((e) => e.id)).toEqual([local, emailFar, emailNear]);
    expect(result.examples[0]!.channel).toBe("linkedin");
  });

  it("does not fill when the channel already has k, and never leaves the voice", async () => {
    const near = await seed({ text: "near linkedin", distance: 1 });
    const mid = await seed({ text: "mid linkedin", distance: 2 });
    await seed({ text: "far linkedin", distance: 3 });
    await seed({ text: "a nearer email", distance: 0.5, channel: "email-professional" });
    await seed({ text: "someone else's post", distance: 0.1, voice: "muse" });
    const result = await recallVoice(
      { writingSamples: storage.writingSamples, embedClient: fakeEmbedder() },
      TENANT,
      { voice: "edward", channel: "linkedin", request: "a post", k: 2 },
    );
    expect(result.examples.map((e) => e.id)).toEqual([near, mid]);
  });

  it("never surfaces pending_review", async () => {
    const published = await seed({ text: "published post", distance: 2 });
    await seed({ text: "still in review", distance: 0.1, source: "approved", outcome: "pending_review" });
    const result = await recallVoice(
      { writingSamples: storage.writingSamples, embedClient: fakeEmbedder() },
      TENANT,
      { voice: "edward", channel: "linkedin", request: "a post", k: 3 },
    );
    expect(result.examples.map((e) => e.id)).toEqual([published]);
    expect(result.avoid).toEqual([]);
  });
});

describe("recallVoice: avoid band", () => {
  it("returns up to 2 rejected samples of the same channel within the k-th example's distance", async () => {
    await seed({ text: "example one", distance: 1 });
    await seed({ text: "example two", distance: 2 });
    await seed({ text: "example three", distance: 3 });
    const nearMiss = await seed({ text: "rejected near", distance: 0.5, source: "approved", outcome: "rejected" });
    const edgeMiss = await seed({ text: "rejected edge", distance: 2.5, source: "approved", outcome: "rejected" });
    await seed({ text: "rejected far", distance: 9, source: "approved", outcome: "rejected" });
    await seed({ text: "rejected other channel", distance: 0.1, channel: "email-professional", source: "approved", outcome: "rejected" });
    const result = await recallVoice(
      { writingSamples: storage.writingSamples, embedClient: fakeEmbedder() },
      TENANT,
      { voice: "edward", channel: "linkedin", request: "a post", k: 3 },
    );
    expect(result.examples).toHaveLength(3);
    expect(result.avoid.map((a) => a.id)).toEqual([nearMiss, edgeMiss]);
    expect(result.avoid[0]!.distance).toBeCloseTo(0.5, 5);
    expect(result.avoid.every((a) => a.text.length > 0)).toBe(true);
  });

  it("is empty when the band excludes every rejected sample", async () => {
    await seed({ text: "the example", distance: 1 });
    await seed({ text: "rejected far", distance: 9, source: "approved", outcome: "rejected" });
    const result = await recallVoice(
      { writingSamples: storage.writingSamples, embedClient: fakeEmbedder() },
      TENANT,
      { voice: "edward", channel: "linkedin", request: "a post" },
    );
    expect(result.examples).toHaveLength(1);
    expect(result.avoid).toEqual([]);
  });
});

describe("recallVoice: no-embedder fallback", () => {
  it("falls back to the newest published samples of the channel, distance null", async () => {
    await seed({ text: "older post", distance: 0.1, ts: "2026-11-18T09:00:00.000Z" });
    await seed({ text: "newest post", distance: 9, ts: "2026-11-20T09:00:00.000Z" });
    await seed({ text: "middle post", distance: 5, ts: "2026-11-19T09:00:00.000Z" });
    await seed({ text: "a newer email", distance: 0.1, channel: "email-professional", ts: "2026-11-21T09:00:00.000Z" });
    await seed({ text: "still in review", distance: 0.1, source: "approved", outcome: "pending_review", ts: "2026-11-22T09:00:00.000Z" });
    embedderState.unreachable = true;
    const result = await recallVoice(
      { writingSamples: storage.writingSamples, embedClient: fakeEmbedder() },
      TENANT,
      { voice: "edward", channel: "linkedin", request: "a post", k: 3 },
    );
    expect(result.examples.map((e) => e.text)).toEqual(["newest post", "middle post", "older post"]);
    expect(result.examples.every((e) => e.distance === null)).toBe(true);
    expect(result.avoid).toEqual([]);
  });

  it("falls back the same way with no embedding client at all", async () => {
    await seed({ text: "only post", distance: 1, ts: "2026-11-20T09:00:00.000Z" });
    const result = await recallVoice(
      { writingSamples: storage.writingSamples, embedClient: null },
      TENANT,
      { voice: "edward", channel: "linkedin", request: "a post" },
    );
    expect(result.examples.map((e) => e.text)).toEqual(["only post"]);
    expect(result.examples[0]!.distance).toBeNull();
    expect(result.avoid).toEqual([]);
  });
});

describe("recallVoice: rules, tenant isolation, empty result", () => {
  it("returns null rules without a rules dir, merged rules with one", async () => {
    await seed({ text: "a post", distance: 1 });
    const deps = { writingSamples: storage.writingSamples, embedClient: fakeEmbedder() };
    const without = await recallVoice(deps, TENANT, { voice: "edward", channel: "linkedin", request: "a post" });
    expect(without.rules).toBeNull();
    expect(without.rules_version).toBeNull();
    expect(without.banned_phrases).toEqual([]);

    const rulesDir = tmpRulesDir();
    writeFileSync(
      join(rulesDir, "edward.yaml"),
      "voice: edward\nrules: [Plain words]\nbanned_phrases: [leverage]\nchannels:\n  linkedin: { rules: [One idea per post] }\naudiences:\n  client-blog: { rules: [Name the reader] }\n",
    );
    process.env["NLM_VOICE_RULES_DIR"] = rulesDir;
    const channelOnly = await recallVoice(deps, TENANT, { voice: "edward", channel: "linkedin", request: "a post" });
    expect(channelOnly.rules).toEqual(["Plain words", "One idea per post"]);
    expect(channelOnly.rules_version).toBe("unversioned");
    expect(channelOnly.banned_phrases).toEqual(["leverage"]);

    const withAudience = await recallVoice(deps, TENANT, {
      voice: "edward",
      channel: "linkedin",
      audience: "client-blog",
      request: "a post",
    });
    expect(withAudience.rules).toEqual(["Plain words", "One idea per post", "Name the reader"]);
  });

  it("keeps one tenant's latest out of another tenant's recall", async () => {
    const { id } = await storage.writingSamples.insert(FOREIGN, {
      voice: "edward",
      channel: "linkedin",
      source: "published",
      outcome: "published",
      text: "their words",
      ts: "2026-11-20T09:00:00.000Z",
    });
    expect(id).toBeDefined();
    const latest = await storage.writingSamples.latest(TENANT, {
      voice: "edward",
      channel: "linkedin",
      outcomes: ["published"],
      k: 5,
    });
    expect(latest).toEqual([]);
  });

  it("returns an empty result, never an error, when there is nothing", async () => {
    const result = await recallVoice(
      { writingSamples: storage.writingSamples, embedClient: fakeEmbedder() },
      TENANT,
      { voice: "edward", channel: "linkedin", request: "a post" },
    );
    expect(result.examples).toEqual([]);
    expect(result.avoid).toEqual([]);
    expect(result.rules).toBeNull();
    expect(result.rules_version).toBeNull();
    expect(result.banned_phrases).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(result.draft_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("mints a fresh draft_id per call", async () => {
    const deps = { writingSamples: storage.writingSamples, embedClient: fakeEmbedder() };
    const input = { voice: "edward", channel: "linkedin", request: "a post" } as const;
    const first = await recallVoice(deps, TENANT, input);
    const second = await recallVoice(deps, TENANT, input);
    expect(first.draft_id).not.toBe(second.draft_id);
  });
});

describe("recallVoice: maxChars trimming", () => {
  const long = (label: string): string => `${label} ${"x".repeat(900)}`;

  beforeEach(async () => {
    await seed({ text: long("post one"), distance: 1 });
    await seed({ text: long("post two"), distance: 2 });
    await seed({ text: long("post three"), distance: 3 });
    await seed({ text: long("rejected one"), distance: 0.5, source: "approved", outcome: "rejected" });
    await seed({ text: long("rejected two"), distance: 1.5, source: "approved", outcome: "rejected" });
    const rulesDir = tmpRulesDir();
    writeFileSync(join(rulesDir, "edward.yaml"), "voice: edward\nrules: [Plain words]\n");
    process.env["NLM_VOICE_RULES_DIR"] = rulesDir;
  });

  it("drops the furthest example first, then avoid, and never rules", async () => {
    const deps = { writingSamples: storage.writingSamples, embedClient: fakeEmbedder() };
    const input = { voice: "edward", channel: "linkedin", request: "a post", k: 3 } as const;
    const full = await recallVoice(deps, TENANT, input);
    expect(full.examples).toHaveLength(3);
    expect(full.avoid).toHaveLength(2);
    expect(full.truncated).toBe(false);

    // One byte under the full size drops exactly the furthest example.
    const oneDown = await recallVoice(deps, TENANT, { ...input, maxChars: JSON.stringify(full).length - 1 });
    expect(oneDown.truncated).toBe(true);
    expect(oneDown.examples.map((e) => e.id)).toEqual(full.examples.slice(0, 2).map((e) => e.id));
    expect(oneDown.avoid.map((a) => a.id)).toEqual(full.avoid.map((a) => a.id));
    expect(oneDown.rules).toEqual(full.rules);

    // A tight budget exhausts the examples before touching avoid, and the
    // result still fits with the rules intact.
    const tight = await recallVoice(deps, TENANT, { ...input, maxChars: 2200 });
    expect(tight.truncated).toBe(true);
    expect(tight.examples).toEqual([]);
    expect(tight.avoid.map((a) => a.id)).toEqual(full.avoid.map((a) => a.id));
    expect(tight.rules).toEqual(["Plain words"]);
    expect(JSON.stringify(tight).length).toBeLessThanOrEqual(2200);
  });
});
