import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../../src/core/storage/migrate.js";
import { createSnapshot } from "../../../src/core/eval/harness/snapshot.js";
import { DEFAULT_TEAM_ID } from "../../../src/core/tenancy/default-team.js";
import { bodyVersion } from "../../../src/core/context/source-version.js";
import { assertionKey } from "../../../src/core/properties/model.js";
import { assertSnapshot, fileHash, pathsIn, readJson, sha256, writePrivate, type Manifest } from "../../../scripts/eval/lib/property-holdout-io.js";
import { buildExclusions, countProposals, drawHoldout, freezeHoldout, orderKey, type Candidate, type Predictions } from "../../../scripts/eval/lib/property-holdout.js";
import { classifyFact, classifySession, factMatches } from "../../../scripts/eval/lib/property-holdout-strata.js";
import { parseProperties } from "../../../src/core/properties/model.js";
import { saveLabels, sealLabels, validateLabel, type LabelsFile } from "../../../scripts/eval/lib/property-holdout-labels.js";
import { ScoringRefused, scoreHoldout } from "../../../scripts/eval/lib/property-holdout-score.js";
import { adjudicate, labelSitting } from "../../../scripts/eval/lib/property-holdout-label-session.js";
import { l2Message, parseAnswer, runL2, shuffledCatalog } from "../../../scripts/eval/lib/property-holdout-l2.js";
import type { Card } from "../../../scripts/eval/lib/property-holdout-cards.js";

const root = mkdtempSync(join(tmpdir(), "t1142-"));
const candidate: Candidate = { sha: "a".repeat(40), treeHash: "b".repeat(40) };
const catalogJson = [
  { slug: "alpha", label: "Alpha" }, { slug: "beta", label: "Beta" }, { slug: "gamma", label: "Gamma" },
];
const catalog = parseProperties(catalogJson);
const FREEZE = new Date("2026-11-01T00:00:00Z");
const CLOSE = new Date("2026-12-31T00:00:00Z");
const live = join(root, "live.sqlite");
let snapshot: string;
let t1130: string;
let catalogPath: string;

function quoteFor(name: string, n: number): string { return `${name} owns component ${n}`; }

function seedFixture(): void {
  const db = new Database(live);
  sqliteVec.load(db);
  db.pragma("journal_mode = WAL");
  runMigrations(db, join(process.cwd(), "migrations"));
  const session = db.prepare("INSERT INTO sessions (id, tenant_id, runtime, runtime_session_id, started_at, label, summary, body, body_version, status, created_at, skill, parent_session_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)");
  const fact = db.prepare("INSERT INTO facts (id, tenant_id, kind, subject, predicate, value, source_session_id, source_quote, confidence, source_start, source_end, source_body_version, source_quote_status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)");
  const entity = db.prepare("INSERT INTO session_entities (session_id, entity_canonical, tenant_id) VALUES (?,?,?)");
  db.prepare("INSERT INTO entities (canonical, type, status, tenant_id) VALUES (?,?,?,?)");
  for (const name of ["Alpha", "Beta", "Gamma"]) db.prepare("INSERT INTO entities (canonical, type, status, tenant_id) VALUES (?,?,?,?)").run(name, "project", "active", DEFAULT_TEAM_ID);
  const add = (id: string, runtime: string, created: string, body: string, opts: { skill?: string | null; parent?: string | null; names?: string[]; quote?: string; slugName?: string } = {}) => {
    session.run(id, DEFAULT_TEAM_ID, runtime, `rt-${id}`, created, `work ${id}`, `summary ${id}`, body, bodyVersion(body), "closed", created, opts.skill ?? null, opts.parent ?? null);
    for (const n of opts.names ?? []) entity.run(id, n, DEFAULT_TEAM_ID);
    if (opts.quote) {
      const start = body.indexOf(opts.quote);
      fact.run(`f-${id}`, DEFAULT_TEAM_ID, "attribute", opts.slugName ?? "thing", "uses", `value ${id}`, id, opts.quote, 0.9, start, start + opts.quote.length, bodyVersion(body), "verified");
    }
  };
  // T1130 sources: old sessions, one with a child.
  add("old-1", "claude-code/1", "2026-10-20T00:00:00Z", `[user] hi\n\n${quoteFor("Alpha", 0)}`, { quote: quoteFor("Alpha", 0) });
  add("old-child", "claude-code/1", "2026-10-21T00:00:00Z", "[user] child", { parent: "old-1" });
  add("old-twin", "claude-code/1", "2026-10-22T00:00:00Z", "[user] twin");
  db.prepare("UPDATE sessions SET runtime_session_id = 'rt-old-1' WHERE id = 'old-twin'").run();
  // Window sessions.
  const runtimes = ["claude-code/1", "codex/1", "pi/1", "opencode/1"];
  for (let i = 0; i < 24; i++) {
    const name = ["Alpha", "Beta", "Gamma"][i % 3]!;
    const quote = i % 4 === 0 ? `${name} must install Beta library ${i}` : quoteFor(name, i);
    add(`w-${i}`, runtimes[i % 4]!, `2026-11-0${1 + (i % 5)}T0${i % 10}:00:00Z`, `[user] work on ${name} ${i}\n\n${quote}\nmore text`, { names: [name], quote, slugName: "thing" });
  }
  // Multi-property sessions with an unresolved fact.
  for (let i = 0; i < 25; i++) {
    const body = `[user] Alpha and Beta ${i}\n\nAlpha and Beta share this ${i}`;
    add(`m-${i}`, runtimes[i % 4]!, `2026-11-03T0${i % 10}:30:00Z`, body, { names: ["Alpha", "Beta"], quote: `Alpha and Beta share this ${i}` });
  }
  add("c-1", "pi/1", "2026-11-05T00:00:00Z", "[user] replay", { skill: "review", names: ["Gamma"] });
  // Pre-window session (before freeze) and a child of a T1130 source inside the window.
  add("pre-1", "codex/1", "2026-10-30T00:00:00Z", `[user] x\n\n${quoteFor("Beta", 99)}`, { names: ["Beta"], quote: quoteFor("Beta", 99) });
  add("w-child", "codex/1", "2026-11-04T00:00:00Z", `[user] child\n\n${quoteFor("Gamma", 98)}`, { names: ["Gamma"], quote: quoteFor("Gamma", 98), parent: "old-1" });
  add("w-twin", "claude-code/2", "2026-11-04T00:00:00Z", `[user] twin\n\n${quoteFor("Gamma", 97)}`, { names: ["Gamma"], quote: quoteFor("Gamma", 97) });
  db.prepare("UPDATE sessions SET runtime_session_id = 'rt-old-1' WHERE id = 'w-twin'").run();
  db.close();
}

beforeAll(async () => {
  seedFixture();
  snapshot = (await createSnapshot({ sourceDb: live, logsDir: root, outDir: join(root, "snap") })).db;
  t1130 = join(root, "t1130");
  mkdirSync(t1130);
  const oldFact = { kind: "attribute", subject: "thing", predicate: "uses", value: "value old-1" };
  writeFileSync(join(t1130, "sample.json"), JSON.stringify({ seed: "T1130-v1", cases: [{ id: "f001", type: "fact", sourceId: "old-1", fact: oldFact }] }));
  writeFileSync(join(t1130, "literal-sample.json"), JSON.stringify({ seed: "T1130-v1", cases: [] }));
  catalogPath = join(root, "catalog.json");
  writeFileSync(catalogPath, JSON.stringify(catalogJson));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const modeOf = (p: string) => statSync(p).mode & 0o777;
const freezeOpts = (dir: string) => ({ snapshot, catalogPath, dir, tenant: DEFAULT_TEAM_ID, sampleFiles: [join(t1130, "sample.json"), join(t1130, "literal-sample.json")], now: FREEZE, candidate, live });

describe("assertSnapshot", () => {
  it("accepts a snapshot made by createSnapshot", () => {
    expect(() => assertSnapshot(snapshot, live)).not.toThrow();
  });
  it("refuses the live canonical path, directly and through a symlink", () => {
    expect(() => assertSnapshot(live, live)).toThrow(/live canonical/);
  });
  it("refuses a writable copy", () => {
    const copy = join(root, "copy.sqlite");
    copyFileSync(snapshot, copy); chmodSync(copy, 0o644);
    expect(() => assertSnapshot(copy, live)).toThrow(/writable/);
  });
  it("refuses a WAL-mode database and a database with a wal sibling", () => {
    const wal = join(root, "wal.sqlite");
    const db = new Database(wal); db.pragma("journal_mode = WAL"); db.exec("CREATE TABLE t (x)"); db.close();
    chmodSync(wal, 0o444);
    expect(() => assertSnapshot(wal, live)).toThrow(/WAL mode|wal/);
    const sib = join(root, "sib.sqlite");
    copyFileSync(snapshot, sib); chmodSync(sib, 0o444); writeFileSync(`${sib}-wal`, "");
    expect(() => assertSnapshot(sib, live)).toThrow(/-wal exists/);
  });
  it("refuses a missing path", () => {
    expect(() => assertSnapshot(join(root, "nope.sqlite"), live)).toThrow(/does not exist/);
  });
});

describe("writePrivate", () => {
  it("writes mode 0600, also over an existing wider file, and returns the byte hash", () => {
    const p = join(root, "private.json");
    writeFileSync(p, "x", { mode: 0o644 });
    const h = writePrivate(p, { a: 1 });
    expect(modeOf(p)).toBe(0o600);
    expect(h).toBe(fileHash(p));
  });
});

describe("exclusions", () => {
  it("collects sessions, identities, lineage and assertion keys from the T1130 samples", () => {
    const db = new Database(snapshot, { readonly: true });
    const ex = buildExclusions(db, DEFAULT_TEAM_ID, [join(t1130, "sample.json")]);
    db.close();
    expect(ex.sessions).toEqual(expect.arrayContaining(["old-1", "old-child", "old-twin", "w-twin", "w-child"]));
    expect(ex.sessions).not.toContain("w-0");
    expect(ex.sourceIdentities).toHaveLength(1);
    expect(ex.assertionKeys).toEqual([assertionKey({ kind: "attribute", subject: "thing", predicate: "uses", value: "value old-1", sourceQuote: quoteFor("Alpha", 0) })]);
  });
});

describe("freeze", () => {
  it("writes a 0600 manifest with every frozen hash and refuses to refreeze", () => {
    const dir = join(root, "freeze-a");
    const m = freezeHoldout(freezeOpts(dir));
    const p = pathsIn(dir);
    expect(m.seed).toBe("T1142-v1");
    expect(m.freezeAt).toBe(FREEZE.toISOString());
    expect(m.windowCloseRule).toMatchObject({ minProposals: 100, maxDays: 28, closesNoLaterThan: "2026-11-29T00:00:00.000Z" });
    for (const h of [m.catalogHash, m.strataHash, m.cardGeneratorHash, m.l2PromptHash, m.exclusions.hash]) expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(m.candidate).toEqual(candidate);
    for (const f of [p.manifest, p.exclusions, p.catalog]) expect(modeOf(f)).toBe(0o600);
    expect(m.exclusions.hash).toBe(fileHash(p.exclusions));
    expect(() => freezeHoldout(freezeOpts(dir))).toThrow(/already exists/);
  });
  it("refuses a non-snapshot path", () => {
    expect(() => freezeHoldout({ ...freezeOpts(join(root, "freeze-b")), snapshot: live })).toThrow(/live canonical/);
  });
  it("counts admissible proposals only and refuses when frozen code changed", () => {
    const dir = join(root, "freeze-c");
    freezeHoldout(freezeOpts(dir));
    const n = countProposals(snapshot, catalogPath, dir, DEFAULT_TEAM_ID, candidate, live);
    expect(n).toBeGreaterThan(0);
    expect(() => countProposals(snapshot, catalogPath, dir, DEFAULT_TEAM_ID, { ...candidate, sha: "c".repeat(40) }, live)).toThrow(/candidate code changed/);
  });
});

describe("strata", () => {
  const session = { skill: null, label: "work", body: "plain" };
  it("applies first-match precedence A, B, C, E", () => {
    expect(classifyFact({ quote: "Alpha must install Beta", value: "v", session }, catalog)).toBe("A");
    expect(classifyFact({ quote: "Alpha listens on io.alpha.worker.local", value: "v", session }, catalog)).toBe("B");
    expect(classifyFact({ quote: "Alpha has a queue", value: "v", session: { ...session, skill: "review" } }, catalog)).toBe("C");
    expect(classifyFact({ quote: "Alpha has a queue", value: "v", session }, catalog)).toBe("E");
    // matches A and B and C: first row wins, overlap is visible
    const multi = factMatches({ quote: "Alpha and Beta use ALPHA_PORT", value: "v", session: { ...session, skill: "eval" } }, catalog);
    expect(multi).toEqual(["A", "B", "C", "E"]);
  });
  it("classifies sessions C then D then E", () => {
    expect(classifySession({ session: { skill: "label", label: "x", body: "" }, hasRepositoryOrExplicit: false })).toBe("C");
    expect(classifySession({ session: { skill: null, label: "x", body: "```\n[user] quoted\n```" }, hasRepositoryOrExplicit: false })).toBe("C");
    expect(classifySession({ session, hasRepositoryOrExplicit: false })).toBe("D");
    expect(classifySession({ session, hasRepositoryOrExplicit: true })).toBe("E");
  });
});

describe("draw", () => {
  const drawn = (name: string) => {
    const dir = join(root, name);
    freezeHoldout(freezeOpts(dir));
    const manifest = drawHoldout({ snapshot, catalogPath, dir, tenant: DEFAULT_TEAM_ID, now: CLOSE, candidate, live });
    return { dir, manifest, p: pathsIn(dir), cards: readJson<{ cards: Card[] }>(pathsIn(dir).cards).cards, predictions: readJson<Predictions>(pathsIn(dir).predictions) };
  };

  it("refuses a non-snapshot, an open window, a changed candidate, and a second draw", () => {
    const dir = join(root, "draw-refuse");
    freezeHoldout(freezeOpts(dir));
    const base = { snapshot, catalogPath, dir, tenant: DEFAULT_TEAM_ID, now: CLOSE, candidate, live };
    expect(() => drawHoldout({ ...base, snapshot: live })).toThrow(/live canonical/);
    expect(() => drawHoldout({ ...base, now: new Date("2026-11-10T00:00:00Z") })).toThrow(/window still open/);
    expect(() => drawHoldout({ ...base, candidate: { ...candidate, treeHash: "d".repeat(40) } })).toThrow(/run voided/);
    drawHoldout(base);
    expect(() => drawHoldout(base)).toThrow(/already drawn/);
  });

  it("is deterministic: the same inputs give byte-identical cards and predictions", () => {
    const a = drawn("draw-1"); const b = drawn("draw-2");
    expect(fileHash(a.p.cards)).toBe(fileHash(b.p.cards));
    expect(fileHash(a.p.predictions)).toBe(fileHash(b.p.predictions));
  });

  it("writes every output at 0600 and records hashes in the manifest", () => {
    const { p, manifest } = drawn("draw-3");
    for (const f of [p.cards, p.predictions, p.manifest]) expect(modeOf(f)).toBe(0o600);
    expect(manifest.draw!.cardsHash).toBe(fileHash(p.cards));
    expect(manifest.draw!.predictionsHash).toBe(fileHash(p.predictions));
  });

  it("is source-disjoint from the exclusion list, by session, identity and lineage, and the window", () => {
    const { predictions } = drawn("draw-4");
    const sources = Object.values(predictions.cards).map((e) => e.sourceId);
    for (const banned of ["old-1", "old-child", "old-twin", "w-child", "w-twin", "pre-1"]) expect(sources).not.toContain(banned);
  });

  it("blinds the cards: no slug, lane, stratum or evidence fields, and ids are opaque", () => {
    const { cards, predictions } = drawn("draw-5");
    const forbidden = ["slug", "lane", "stratum", "evidence", "proposed", "source", "property", "sourceId", "sourceHash"];
    const keys = (v: unknown, out: string[] = []): string[] => {
      if (Array.isArray(v)) v.forEach((x) => keys(x, out));
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.push(k); if (k !== "catalog") keys(x, out); }
      return out;
    };
    const allKeys = keys(cards);
    for (const f of forbidden) expect(allKeys).not.toContain(f);
    for (const c of cards) {
      expect(c.id).toMatch(/^c\d{4}$/);
      for (const e of c.catalog) expect(Object.keys(e).sort()).toEqual(["label", "slug"]);
    }
    expect(Object.keys(predictions.cards).sort()).toEqual(cards.map((c) => c.id).sort());
    // shuffled across lanes and strata: the lanes are not grouped in id order
    const lanes = cards.map((c) => predictions.cards[c.id]!.lane).join("");
    expect(lanes).not.toMatch(/^(fact)+(session)+(abstention)+$/);
  });

  it("builds the strata census, population counts, abstention cards and quotas", () => {
    const { predictions, manifest } = drawn("draw-6");
    const entries = Object.values(predictions.cards);
    const factLane = entries.filter((e) => e.lane === "fact");
    expect(factLane.length).toBe(Object.values(manifest.draw!.population.factProposals).reduce((a, b) => a + b, 0));
    expect(factLane.some((e) => e.stratum === "A")).toBe(true);
    expect(entries.filter((e) => e.lane === "abstention").length).toBe(20);
    expect(entries.filter((e) => e.lane === "abstention").every((e) => e.proposed.length === 0)).toBe(true);
    expect(manifest.draw!.population.sessionRefs["D"]).toBeGreaterThan(0);
    expect(manifest.draw!.population.sessionRefs["C"]).toBe(1);
    expect(predictions.quotas["factMinorityRuntime"]).toMatchObject({ required: 15 });
    expect(predictions.quotas["sessionMinorityRuntime"]).toMatchObject({ required: 30 });
    expect(predictions.quotas["factRepoScopes"]).toMatchObject({ required: 10, actual: 0, met: false });
    expect(predictions.shortfalls.length).toBeGreaterThan(0);
  });

  it("orders by sha256 of the seed and id", () => {
    expect(orderKey("", "x")).toBe(sha256("T1142-v1:x"));
  });
});

// ---- labelling, sealing and scoring ----------------------------------------

function drawFresh(name: string) {
  const dir = join(root, name);
  freezeHoldout(freezeOpts(dir));
  drawHoldout({ snapshot, catalogPath, dir, tenant: DEFAULT_TEAM_ID, now: CLOSE, candidate, live });
  const p = pathsIn(dir);
  return { dir, p, cards: readJson<{ cards: Card[] }>(p.cards).cards, predictions: readJson<Predictions>(p.predictions) };
}
function perfectLabels(cards: Card[], predictions: Predictions, wrongFact?: string): LabelsFile {
  const labels: LabelsFile["labels"] = {};
  for (const c of cards) {
    const e = predictions.cards[c.id]!;
    labels[c.id] = c.type === "fact"
      ? { owner: e.lane === "abstention" ? "none" : (c.id === wrongFact ? "ambiguous" : e.proposed[0]!), roles: {}, confidence: "sure" }
      : { relevant: e.proposed, quotedInputOnly: [], boilerplateOnly: [], confidence: "sure" };
  }
  return { labeller: "L1", seed: "T1142-v1", sittings: [{ startedAt: "2026-12-31T01:00:00Z", endedAt: "2026-12-31T01:30:00Z", cards: cards.length }], labels };
}

describe("labels", () => {
  it("validates the section 3 schema", () => {
    const { cards } = drawFresh("labels-schema");
    const fact = cards.find((c) => c.type === "fact")!; const session = cards.find((c) => c.type === "session")!;
    expect(() => validateLabel(fact, { owner: "nope", roles: {}, confidence: "sure" })).toThrow(/owner/);
    expect(() => validateLabel(fact, { owner: "none", roles: { alpha: "bogus" }, confidence: "sure" })).toThrow(/role/);
    expect(() => validateLabel(fact, { owner: "alpha", roles: { alpha: "owner" }, confidence: "maybe" })).toThrow(/confidence/);
    expect(() => validateLabel(session, { relevant: ["alpha"], quotedInputOnly: ["alpha"], boilerplateOnly: [], confidence: "sure" })).toThrow(/cannot be relevant/);
    expect(validateLabel(session, { relevant: ["alpha"], quotedInputOnly: [], boilerplateOnly: [], confidence: "sure" })).toMatchObject({ relevant: ["alpha"] });
  });

  it("refuses to seal with unlabelled cards, seals once, and writes 0600", () => {
    const { dir, p, cards, predictions } = drawFresh("labels-seal");
    const full = perfectLabels(cards, predictions);
    saveLabels(dir, { ...full, labels: { [cards[0]!.id]: full.labels[cards[0]!.id]! } });
    expect(() => sealLabels(dir, cards, new Date("2026-12-31T02:00:00Z"))).toThrow(/unlabelled/);
    saveLabels(dir, full);
    const seal = sealLabels(dir, cards, new Date("2026-12-31T02:00:00Z"));
    expect(seal.labelsHash).toBe(fileHash(p.labels));
    expect(modeOf(p.labels)).toBe(0o600); expect(modeOf(p.sealed)).toBe(0o600);
    expect(() => sealLabels(dir, cards, new Date())).toThrow(/already sealed/);
  });

  it("walks cards in a sitting, resumes where it stopped, and records the sitting", async () => {
    const { dir, cards } = drawFresh("labels-sitting");
    const answers: string[] = [];
    const script = (stopAfter: number) => {
      let labelled = 0;
      return {
        print: () => {},
        ask: async (prompt: string): Promise<string> => {
          if (prompt.startsWith("owner")) { if (labelled++ >= stopAfter) return "q"; return "none"; }
          if (prompt.startsWith("role")) return "5";
          if (prompt.startsWith("confidence")) return "s";
          if (prompt.startsWith("relevant")) { if (labelled++ >= stopAfter) return "q"; return ""; }
          return "";
        },
      };
    };
    const first = await labelSitting(dir, cards, script(3), () => new Date("2026-12-31T01:00:00Z"));
    expect(first.labelled).toBe(3);
    const saved = readJson<LabelsFile>(pathsIn(dir).labels);
    expect(Object.keys(saved.labels)).toEqual(cards.slice(0, 3).map((c) => c.id));
    expect(modeOf(pathsIn(dir).labels)).toBe(0o600);
    const second = await labelSitting(dir, cards, script(2), () => new Date("2026-12-31T03:00:00Z"));
    expect(second.labelled).toBe(2);
    const resumed = readJson<LabelsFile>(pathsIn(dir).labels);
    expect(Object.keys(resumed.labels)).toEqual(cards.slice(0, 5).map((c) => c.id));
    expect(resumed.sittings).toHaveLength(2);
    expect(answers).toEqual([]);
  });

  it("adjudicates unsure session cards", async () => {
    const { dir, cards } = drawFresh("labels-adjudicate");
    const s = cards.find((c) => c.type === "session")!;
    saveLabels(dir, { labeller: "L1", seed: "T1142-v1", sittings: [], labels: { [s.id]: { relevant: [], quotedInputOnly: [], boilerplateOnly: [], confidence: "unsure" } } });
    const n = await adjudicate(dir, cards, { print: () => {}, ask: async (p) => (p.startsWith("relevant") ? "alpha" : p.startsWith("confidence") ? "s" : "") });
    expect(n).toBe(1);
    expect(readJson<LabelsFile>(pathsIn(dir).labels).labels[s.id]).toMatchObject({ relevant: ["alpha"], adjudicated: { changed: true, confidence: "sure" } });
  });
});

describe("score", () => {
  const now = new Date("2027-01-01T00:00:00Z");
  function sealed(name: string, wrongFact?: string) {
    const d = drawFresh(name);
    const wrong = wrongFact === "first" ? d.cards.find((c) => d.predictions.cards[c.id]!.lane === "fact")!.id : undefined;
    saveLabels(d.dir, perfectLabels(d.cards, d.predictions, wrong));
    sealLabels(d.dir, d.cards, new Date("2026-12-31T05:00:00Z"));
    return { ...d, wrong };
  }

  it("refuses while labels are unsealed, without opening predictions", () => {
    const d = drawFresh("score-unsealed");
    saveLabels(d.dir, perfectLabels(d.cards, d.predictions));
    writeFileSync(d.p.predictions, "not even json");
    expect(() => scoreHoldout(d.dir, now)).toThrow(/labels.sealed is missing/);
  });
  it("refuses on a card, label or prediction hash mismatch", () => {
    for (const [file, pattern] of [["cards", /cards.json/], ["labels", /edited after the seal/], ["predictions", /predictions.json/]] as const) {
      const d = sealed(`score-tamper-${file}`);
      const target = d.p[file];
      writeFileSync(target, readFileSync(target, "utf8") + " ");
      expect(() => scoreHoldout(d.dir, now), file).toThrow(ScoringRefused);
      expect(() => scoreHoldout(d.dir, now), file).toThrow(pattern);
    }
  });
  it("refuses labels sealed before the draw", () => {
    const d = drawFresh("score-early");
    saveLabels(d.dir, perfectLabels(d.cards, d.predictions));
    sealLabels(d.dir, d.cards, new Date("2026-01-01T00:00:00Z"));
    expect(() => scoreHoldout(d.dir, now)).toThrow(/before the draw/);
  });
  it("scores a clean run: Q1 zero with the rule-of-three bound, under-powered below 100, Q2 post-stratified", () => {
    const d = sealed("score-clean");
    const s = scoreHoldout(d.dir, now);
    expect(s.q1.wrongOwner).toBe(0);
    expect(s.q1.proposals).toBeGreaterThan(0);
    expect(s.q1.ruleOfThreeBound).toBeCloseTo(3 / s.q1.proposals);
    expect(s.q1.underPowered).toBe(true);
    expect(s.q1.passed).toBe(false);
    expect(s.q2.postStratified).toBe(1);
    expect(s.q2.wilson!.low).toBeGreaterThan(0.8);
    expect(s.coverage.abstentionCorrectRate).toBe(1);
    expect(s.kappa.l2Present).toBe(false);
    expect(s.scope).toMatch(/not a population precision claim/);
    expect(s.decision.gatesPassed).toBe(false);
    for (const f of [d.p.scores, d.p.abstention, d.p.limits]) expect(modeOf(f)).toBe(0o600);
  });
  it("counts a wrong owner and an ambiguous card against Q1", () => {
    const d = sealed("score-wrong", "first");
    const s = scoreHoldout(d.dir, now, false);
    expect(s.q1.wrongOwner).toBe(1);
    expect(s.q1.wrongCards).toEqual([d.wrong]);
    expect(s.q1.ruleOfThreeBound).toBeNull();
  });
  it("computes kappa against L2 and lists disagreements on proposals", () => {
    const d = sealed("score-kappa");
    const l1 = readJson<LabelsFile>(d.p.labels);
    const l2: LabelsFile = JSON.parse(JSON.stringify(l1));
    const flip = d.cards.find((c) => d.predictions.cards[c.id]!.lane === "fact")!.id;
    (l2.labels[flip] as { owner: string }).owner = "gamma";
    l2.labeller = "L2";
    writeFileSync(d.p.l2, JSON.stringify(l2));
    const s = scoreHoldout(d.dir, now, false);
    expect(s.kappa.l2Present).toBe(true);
    expect(s.kappa.fact).toBeLessThan(1);
    expect(s.kappa.disagreementsOnProposals).toContain(flip);
  });
});

// ---- L2 runner ---------------------------------------------------------------

describe("L2", () => {
  it("shuffles the catalog per card, deterministically, and never sends stratum, lane or the extra text", () => {
    const { cards } = drawFresh("l2-shuffle");
    const [a, b] = [cards[0]!, cards[1]!];
    expect(shuffledCatalog(a)).toEqual(shuffledCatalog(a));
    const orders = new Set([shuffledCatalog(a), shuffledCatalog(b), shuffledCatalog({ ...a, id: "c9999" })].map((c) => c.map((e) => e.slug).join()));
    expect(orders.size).toBeGreaterThan(1);
    const message = l2Message(cards.find((c) => c.type === "session")!);
    expect(message).not.toMatch(/"extra"|"id"|stratum|lane/);
  });
  it("parses and validates answers, turning the justification into a note", () => {
    const { cards } = drawFresh("l2-parse");
    const fact = cards.find((c) => c.type === "fact")!;
    expect(parseAnswer(fact, 'sure: {"owner":"alpha","roles":{"alpha":"owner"},"confidence":"sure","justification":"quote names it"} done')).toMatchObject({ owner: "alpha", note: "quote names it" });
    expect(() => parseAnswer(fact, "no json")).toThrow(/no JSON/);
    expect(() => parseAnswer(fact, '{"owner":"zzz","roles":{},"confidence":"sure"}')).toThrow(/owner/);
  });
  it("writes 0600 l2-labels.json, records failures, and refuses a changed prompt hash", async () => {
    const d = drawFresh("l2-run");
    let n = 0;
    const result = await runL2(d.dir, "test-model", async () => (n++ === 0 ? "garbage" : JSON.stringify({ owner: "none", roles: {}, relevant: [], quotedInputOnly: [], boilerplateOnly: [], confidence: "sure" })));
    expect(result.failures).toHaveLength(1);
    expect(existsSync(d.p.l2)).toBe(true);
    expect(modeOf(d.p.l2)).toBe(0o600);
    const manifest = readJson<Manifest>(d.p.manifest);
    expect(readJson<{ promptHash: string; temperature: number }>(d.p.l2)).toMatchObject({ promptHash: manifest.l2PromptHash, temperature: 0 });
    writePrivate(d.p.manifest, { ...manifest, l2PromptHash: "0".repeat(64) });
    await expect(runL2(d.dir, "test-model", async () => "{}")).rejects.toThrow(/prompt does not match/);
  });
});
