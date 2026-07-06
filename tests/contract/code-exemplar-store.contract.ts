/**
 * Backend-agnostic contract for the CodeExemplarStore port.
 * Integration tests supply a harness with a fresh, migrated, empty Storage.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Storage } from "../../src/ports/storage.js";
import type { CodeExemplarInput } from "../../src/shared/types.js";
import { codeHash } from "../../src/core/exemplars/ingest-exemplar.js";

function unitVec(i: number): Float32Array {
  const v = new Float32Array(768);
  v[i] = 1;
  return v;
}

function makeExemplarInput(overrides: Partial<CodeExemplarInput> = {}): CodeExemplarInput {
  const code = overrides.code ?? "function add(a, b) {\n  return a + b;\n}";
  return {
    installScope: "install-test",
    signalId: null,
    sessionId: null,
    repo: "/repo/alpha",
    model: "qwen3-coder",
    lang: "ts",
    taskContext: "add two numbers",
    code,
    codeHash: codeHash(code),
    outcome: "pass",
    gitSha: null,
    survived: null,
    scope: null,
    ts: "2026-06-15T12:00:00.000Z",
    ...overrides,
  };
}

export interface CodeExemplarStoreContractHarness {
  readonly name: string;
  setup(): Promise<Storage>;
  teardown(storage: Storage): Promise<void>;
}

export function runCodeExemplarStoreContract(h: CodeExemplarStoreContractHarness): void {
  describe(`CodeExemplarStore contract: ${h.name}`, () => {
    let storage: Storage;

    beforeEach(async () => { storage = await h.setup(); });
    afterEach(async () => { await h.teardown(storage); });

    it("inserts and retrieves an exemplar by id", async () => {
      const inp = makeExemplarInput();
      const { id, skipped } = await storage.exemplars.insert(inp);
      expect(skipped).toBe(false);
      const fetched = await storage.exemplars.getById(id);
      expect(fetched).not.toBeNull();
      expect(fetched!.code).toBe(inp.code);
      expect(fetched!.outcome).toBe("pass");
      expect(fetched!.repo).toBe("/repo/alpha");
    });

    it("insert is idempotent on duplicate (scope, repo, code_hash, outcome)", async () => {
      const inp = makeExemplarInput();
      const first = await storage.exemplars.insert(inp);
      const second = await storage.exemplars.insert(inp);
      expect(first.id).toBe(second.id);
      expect(second.skipped).toBe(true);
    });

    it("different outcomes for the same code produce distinct rows", async () => {
      const code = "const x = 1;";
      const passInp = makeExemplarInput({ code, outcome: "pass", codeHash: codeHash(code) });
      const failInp = makeExemplarInput({ code, outcome: "fail", codeHash: codeHash(code) });
      const r1 = await storage.exemplars.insert(passInp);
      const r2 = await storage.exemplars.insert(failInp);
      expect(r1.id).not.toBe(r2.id);
      expect(r1.skipped).toBe(false);
      expect(r2.skipped).toBe(false);
    });

    it("insertMany skips duplicates and returns inserted count", async () => {
      const inp = makeExemplarInput();
      await storage.exemplars.insert(inp);
      const count = await storage.exemplars.insertMany([
        inp,
        makeExemplarInput({ code: "const y = 2;", codeHash: codeHash("const y = 2;"), outcome: "fail" }),
      ]);
      expect(count).toBe(1);
    });

    it("pruneReverted deletes survived=0 rows", async () => {
      const reverted = makeExemplarInput({ survived: 0, ts: "2026-06-14T00:00:00.000Z" });
      const good = makeExemplarInput({ code: "const z = 3;", codeHash: codeHash("const z = 3;"), survived: 1 });
      const { id: rId } = await storage.exemplars.insert(reverted);
      await storage.exemplars.insert(good);
      const deleted = await storage.exemplars.pruneReverted("install-test");
      expect(deleted).toBe(1);
      expect(await storage.exemplars.getById(rId)).toBeNull();
    });

    it("pruneOlderThan deletes rows with ts < cutoff", async () => {
      const old = makeExemplarInput({ ts: "2026-01-01T00:00:00.000Z" });
      const recent = makeExemplarInput({ code: "const w = 4;", codeHash: codeHash("const w = 4;"), ts: "2026-06-15T00:00:00.000Z" });
      const { id: oldId } = await storage.exemplars.insert(old);
      const { id: newId } = await storage.exemplars.insert(recent);
      const deleted = await storage.exemplars.pruneOlderThan("2026-06-01T00:00:00.000Z");
      expect(deleted).toBe(1);
      expect(await storage.exemplars.getById(oldId)).toBeNull();
      expect(await storage.exemplars.getById(newId)).not.toBeNull();
    });

    it("a freshly inserted exemplar is active, llm-sourced", async () => {
      const { id } = await storage.exemplars.insert(makeExemplarInput());
      const fetched = await storage.exemplars.getById(id);
      expect(fetched).not.toBeNull();
      expect(fetched!.retiredAt).toBeNull();
      expect(fetched!.labelSource).toBe("llm");
    });

    it("setVerdict retire sets retired_at + label_source", async () => {
      const { id } = await storage.exemplars.insert(makeExemplarInput());
      const res = await storage.exemplars.setVerdict(id, { retired: true }, "human");
      expect(res.status).toBe("applied");
      const fetched = await storage.exemplars.getById(id);
      expect(fetched!.retiredAt).not.toBeNull();
      expect(fetched!.labelSource).toBe("human");
    });

    it("setVerdict can relabel outcome and un-retire", async () => {
      const { id } = await storage.exemplars.insert(makeExemplarInput());
      await storage.exemplars.setVerdict(id, { retired: true, outcome: "fail" }, "human");
      const res = await storage.exemplars.setVerdict(id, { retired: false }, "human");
      expect(res.status).toBe("applied");
      const fetched = await storage.exemplars.getById(id);
      expect(fetched!.retiredAt).toBeNull();
      expect(fetched!.outcome).toBe("fail");
      expect(fetched!.labelSource).toBe("human");
    });

    it("human wins: an llm verdict no-ops on a human-sourced row", async () => {
      const { id } = await storage.exemplars.insert(makeExemplarInput());
      await storage.exemplars.setVerdict(id, { retired: true }, "human");
      const res = await storage.exemplars.setVerdict(id, { retired: false }, "llm");
      expect(res.status).toBe("human_locked");
      const fetched = await storage.exemplars.getById(id);
      expect(fetched!.retiredAt).not.toBeNull(); // unchanged — human verdict held
      expect(fetched!.labelSource).toBe("human");
    });

    it("an llm verdict applies on an llm-sourced (default) row", async () => {
      const { id } = await storage.exemplars.insert(makeExemplarInput());
      const res = await storage.exemplars.setVerdict(id, { retired: true }, "llm");
      expect(res.status).toBe("applied");
      expect((await storage.exemplars.getById(id))!.labelSource).toBe("llm");
    });

    it("setVerdict on a missing id reports not_found", async () => {
      const res = await storage.exemplars.setVerdict("nope", { retired: true }, "human");
      expect(res.status).toBe("not_found");
    });

    it("applyBucketCap evicts oldest rows beyond the cap", async () => {
      const makeN = async (n: number) => {
        for (let i = 0; i < n; i++) {
          const code = `const v${i} = ${i};`;
          await storage.exemplars.insert(
            makeExemplarInput({
              code,
              codeHash: codeHash(code),
              outcome: "pass",
              ts: `2026-06-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
            }),
          );
        }
      };
      await makeN(5);
      const deleted = await storage.exemplars.applyBucketCap("install-test", 3);
      expect(deleted).toBe(2);
    });

    it("searchByVector excludes retired exemplars but getById still returns them", async () => {
      const inp = makeExemplarInput();
      const { id } = await storage.exemplars.insert(inp);
      await storage.exemplars.upsertEmbedding(id, unitVec(0));
      // present before retire
      const before = await storage.exemplars.searchByVector(unitVec(0), { installScope: inp.installScope, k: 5 });
      expect(before.map((h) => h.id)).toContain(id);
      // retire → excluded from search, still in getById
      await storage.exemplars.setVerdict(id, { retired: true }, "human");
      const after = await storage.exemplars.searchByVector(unitVec(0), { installScope: inp.installScope, k: 5 });
      expect(after.map((h) => h.id)).not.toContain(id);
      expect(await storage.exemplars.getById(id)).not.toBeNull();
    });
  });
}
