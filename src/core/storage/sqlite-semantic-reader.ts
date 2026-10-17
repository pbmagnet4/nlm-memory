import { Worker } from "node:worker_threads";
import type { SearchOptions, SemanticNeighbor } from "@ports/session-store.js";
import type { FactEligibility, FactSemanticNeighbor } from "@ports/fact-store.js";

export type SemanticRead = {
  readonly tenantId: string;
  readonly queryVector: Float32Array;
  readonly limit: number;
} & ({ readonly lane: "sessions"; readonly options?: SearchOptions } | { readonly lane: "facts"; readonly options?: FactEligibility });
export type SemanticRows = readonly SemanticNeighbor[] | readonly FactSemanticNeighbor[];
interface Pending {
  readonly request: SemanticRead;
  readonly signal: AbortSignal;
  readonly resolve: (rows: SemanticRows) => void;
  readonly reject: (error: Error) => void;
  readonly cleanup: () => void;
}
interface Slot { readonly worker: Worker; pending?: Pending | undefined; stopping?: Promise<number> | undefined }

/** Only the measured vector reads leave the main connection. No SQL comes from callers. */
export class SqliteSemanticReader {
  private readonly slots = new Set<Slot>();
  private readonly queue: Pending[] = [];
  private closed = false;
  constructor(private readonly dbPath: string, private readonly onRead?: (lane: SemanticRead["lane"], sqlMs: number) => void) {}

  read(request: SemanticRead, signal: AbortSignal): Promise<SemanticRows> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.closed) return Promise.reject(new Error("semantic reader closed"));
    if (this.queue.length >= 8) return Promise.reject(new Error("semantic read queue full"));
    return new Promise((resolve, reject) => {
      const abort = () => {
        const queued = this.queue.indexOf(pending);
        if (queued >= 0) this.queue.splice(queued, 1);
        const slot = [...this.slots].find((s) => s.pending === pending);
        pending.cleanup();
        reject(new Error("semantic read cancelled"));
        if (slot) { slot.pending = undefined; this.stop(slot); }
      };
      const pending: Pending = { request, signal, resolve, reject, cleanup: () => signal.removeEventListener("abort", abort) };
      signal.addEventListener("abort", abort, { once: true });
      this.queue.push(pending);
      this.drain();
    });
  }
  private spawn(): Slot {
    const entry = new URL("./sqlite-semantic-worker.js", import.meta.url);
    const source = import.meta.url.endsWith(".ts");
    const url = source ? new URL(`data:text/javascript,${encodeURIComponent(
      `import { createRequire } from 'node:module'; const require = createRequire(${JSON.stringify(import.meta.url)}); const { register } = require('tsx/esm/api'); register(); await import(${JSON.stringify(entry.href.replace(/\.js$/, ".ts"))});`,
    )}`) : entry;
    const slot: Slot = { worker: new Worker(url, { workerData: { dbPath: this.dbPath } }) };
    this.slots.add(slot);
    slot.worker.on("message", (reply: { rows?: SemanticRows; error?: string; sqlMs: number }) => {
      const pending = slot.pending;
      if (!pending || slot.stopping) return;
      slot.pending = undefined;
      pending.cleanup();
      this.onRead?.(pending.request.lane, reply.sqlMs);
      if (reply.error) pending.reject(new Error(reply.error));
      else pending.resolve(reply.rows!);
      this.drain();
    });
    slot.worker.on("error", () => {
      slot.pending?.cleanup();
      slot.pending?.reject(new Error("semantic read worker failed"));
      slot.pending = undefined;
      this.stop(slot);
    });
    slot.worker.on("exit", () => {
      slot.pending?.cleanup();
      slot.pending?.reject(new Error("semantic read worker exited"));
      slot.pending = undefined;
      this.slots.delete(slot);
      this.drain();
    });
    return slot;
  }
  private stop(slot: Slot): void {
    slot.stopping ??= slot.worker.terminate();
  }
  private drain(): void {
    if (this.closed) return;
    while (this.queue.length) {
      let slot: Slot | undefined;
      try {
        slot = [...this.slots].find((s) => !s.pending && !s.stopping)
          ?? (this.slots.size < 2 ? this.spawn() : undefined);
      } catch {
        const failed = this.queue.shift()!;
        failed.cleanup();
        failed.reject(new Error("semantic worker startup failed"));
        continue;
      }
      if (!slot) return;
      const pending = this.queue.shift()!;
      slot.pending = pending;
      try { slot.worker.postMessage(pending.request); }
      catch {
        pending.cleanup();
        pending.reject(new Error("semantic read dispatch failed"));
        slot.pending = undefined;
        this.stop(slot);
      }
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const pending of this.queue.splice(0)) {
      pending.cleanup();
      pending.reject(new Error("semantic reader closed"));
    }
    await Promise.all([...this.slots].map(async (slot) => {
      slot.pending?.cleanup();
      slot.pending?.reject(new Error("semantic reader closed"));
      slot.pending = undefined;
      this.stop(slot);
      await slot.stopping;
    }));
  }
}
