import { EventEmitter, getEventListeners } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { SqliteSemanticReader } from "../../../../src/core/storage/sqlite-semantic-reader.js";

const state = vi.hoisted(() => ({ workers: [] as EventEmitter[], fail: false }));
vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events");
  return { Worker: class extends EventEmitter {
    postMessage = vi.fn();
    terminate = vi.fn(async () => { this.emit("exit", 0); return 0; });
    constructor() { super(); if (state.fail) throw new Error("startup"); state.workers.push(this); }
  } };
});
const request = { lane: "sessions" as const, tenantId: "a", queryVector: new Float32Array(768), limit: 4 };
afterEach(() => { state.workers = []; state.fail = false; });
it("bounds workers and queue, aborts queued/active work, reaps workers on close", async () => {
  const reader = new SqliteSemanticReader("fixture.sqlite");
  const stopped = new AbortController(); stopped.abort();
  await expect(reader.read(request, stopped.signal)).rejects.toBeDefined();
  expect(state.workers).toHaveLength(0);
  const controllers = Array.from({ length: 11 }, () => new AbortController());
  const reads = controllers.map((c) => reader.read(request, c.signal).catch((e: unknown) => e));
  expect(state.workers).toHaveLength(2);
  expect(await reads[10]).toBeInstanceOf(Error);
  controllers[3]!.abort();
  expect(await reads[3]).toBeInstanceOf(Error);
  expect(getEventListeners(controllers[3]!.signal, "abort")).toHaveLength(0);
  controllers[0]!.abort();
  expect(await reads[0]).toBeInstanceOf(Error);
  await reader.close();
  await Promise.all(reads);
  controllers.forEach((c) => expect(getEventListeners(c.signal, "abort")).toHaveLength(0));
  state.workers.forEach((w) => expect((w as unknown as { terminate: unknown }).terminate).toHaveBeenCalledOnce());
  await expect(reader.read(request, new AbortController().signal)).rejects.toThrow("closed");
});
it("a hanging native worker holds its slot until actual exit, even after response cancellation", async () => {
  const reader = new SqliteSemanticReader("fixture.sqlite");
  const a = new AbortController(); const b = new AbortController(); const c = new AbortController();
  const first = reader.read(request, a.signal).catch((e: unknown) => e);
  const second = reader.read(request, b.signal).catch((e: unknown) => e);
  let reap!: (code: number) => void;
  const worker = state.workers[0]! as EventEmitter & { terminate: ReturnType<typeof vi.fn> };
  worker.terminate.mockImplementation(() => new Promise<number>((resolve) => { reap = resolve; }));
  a.abort(); await first;
  const queued = reader.read(request, c.signal).catch((e: unknown) => e);
  expect(state.workers).toHaveLength(2);
  worker.emit("exit", 0); reap(0);
  expect(state.workers).toHaveLength(3);
  await reader.close(); await Promise.all([second, queued]);
});
it("cleans listeners on result, worker error, and constructor error", async () => {
  const reader = new SqliteSemanticReader("fixture.sqlite");
  const controller = new AbortController();
  const first = reader.read(request, controller.signal);
  state.workers[0]!.emit("message", { rows: [], sqlMs: 1 });
  expect(await first).toEqual([]);
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  const failed = reader.read(request, controller.signal).catch((e: unknown) => e);
  state.workers[0]!.emit("error", new Error("fixture"));
  expect(await failed).toBeInstanceOf(Error);
  state.fail = true;
  await expect(reader.read(request, controller.signal)).rejects.toThrow("startup");
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  await reader.close();
});
