import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer as createTcpServer } from "node:net";
import { createServer as createHttpServer, type ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";

describe("daemon shutdown", () => {
  it.each([
    { name: "scheduler disabled", args: ["--no-scheduler"] },
    { name: "no detected adapters", args: [] },
  ])("handles SIGTERM and closes its database with $name", async ({ args }) => {
    const home = mkdtempSync(join(tmpdir(), "nlm-daemon-shutdown-"));
    const database = join(home, "canonical.sqlite");
    const port = await new Promise<number>((resolve, reject) => {
      const probe = createTcpServer();
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const address = probe.address();
        if (!address || typeof address === "string") return reject(new Error("no test port"));
        probe.close(() => resolve(address.port));
      });
    });
    const child = spawn(process.execPath, ["--import", "tsx", "src/cli/nlm.ts", "start", ...args], {
      cwd: process.cwd(),
      env: {
        PATH: process.env["PATH"], HOME: home, NLM_DB_PATH: database,
        NLM_PORT: String(port), NLM_MCP_TOKEN: "synthetic-test-token",
        NLM_CLASSIFIER_BASE_URL: "http://127.0.0.1:9", NLM_LOOP_LOG: "0", NLM_ADAPTERS: "__none__",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    try {
      const deadline = Date.now() + 20_000;
      while (!stderr.includes("http listening") && child.exitCode === null && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(stderr).toContain("http listening");
      child.kill("SIGTERM");
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        exited,
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("daemon did not exit")), 10_000); }),
      ]).finally(() => { if (timeout) clearTimeout(timeout); });
      expect(result).toEqual({ code: 0, signal: null });
      const db = new Database(database, { readonly: true });
      try { expect(db.pragma("quick_check", { simple: true })).toBe("ok"); }
      finally { db.close(); }
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await exited;
      }
      rmSync(home, { recursive: true, force: true });
    }
  }, 40_000);

  it("waits for an accepted background ingest before exiting", async () => {
    const home = mkdtempSync(join(tmpdir(), "nlm-daemon-ingest-"));
    const database = join(home, "canonical.sqlite");
    let releaseResponse!: ServerResponse;
    let markBlocked!: () => void;
    const blocked = new Promise<void>((resolve) => { markBlocked = resolve; });
    const classifier = createHttpServer((request, response) => {
      request.resume();
      if (request.url?.includes("chat/completions")) {
        releaseResponse = response;
        markBlocked();
      } else {
        response.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => classifier.listen(0, "127.0.0.1", resolve));
    const classifierAddress = classifier.address();
    if (!classifierAddress || typeof classifierAddress === "string") throw new Error("no classifier port");
    const daemonPort = await new Promise<number>((resolve, reject) => {
      const probe = createTcpServer();
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const address = probe.address();
        if (!address || typeof address === "string") return reject(new Error("no daemon port"));
        probe.close(() => resolve(address.port));
      });
    });
    const child = spawn(process.execPath, ["--import", "tsx", "src/cli/nlm.ts", "start", "--no-scheduler"], {
      cwd: process.cwd(),
      env: {
        PATH: process.env["PATH"], HOME: home, NLM_DB_PATH: database, NLM_PORT: String(daemonPort),
        NLM_MCP_TOKEN: "synthetic-test-token", NLM_OLLAMA_URL: "http://127.0.0.1:9",
        NLM_CLASSIFIER: "openai", NLM_CLASSIFIER_MODEL: "synthetic", NLM_CLASSIFIER_BASE_URL: `http://127.0.0.1:${classifierAddress.port}/v1`,
        NLM_LOOP_LOG: "0",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
    try {
      const deadline = Date.now() + 20_000;
      while (!stderr.includes("http listening") && child.exitCode === null && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(stderr).toContain("http listening");
      const base = `http://127.0.0.1:${daemonPort}`;
      const sourceResponse = await fetch(`${base}/api/sources`, {
        method: "POST",
        headers: { authorization: "Bearer synthetic-test-token", "content-type": "application/json" },
        body: JSON.stringify({ kind: "webhook", name: "synthetic", runtimeLabel: "test" }),
      });
      expect(sourceResponse.status).toBe(201);
      const source = await sourceResponse.json() as { token: string };
      const ingest = await fetch(`${base}/api/ingest`, {
        method: "POST", headers: { authorization: `Bearer ${source.token}`, "content-type": "application/json" },
        body: JSON.stringify({ text: "Synthetic test transcript for shutdown tracking." }),
      });
      expect(ingest.status).toBe(202);
      await Promise.race([blocked, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("classifier not called")), 10_000))]);
      child.kill("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(child.exitCode).toBeNull();
      releaseResponse.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          label: "synthetic", summary: "synthetic", entities: [], decisions: [], open: [], facts: [], confidence: 0.1,
        }) } }],
      }));
      expect(await exited).toBe(0);
      const db = new Database(database, { readonly: true });
      try { expect(db.pragma("quick_check", { simple: true })).toBe("ok"); }
      finally { db.close(); }
    } finally {
      releaseResponse?.destroy();
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
      await new Promise<void>((resolve) => classifier.close(() => resolve()));
      rmSync(home, { recursive: true, force: true });
    }
  }, 40_000);

  it("reports failure rather than a clean fence when an active child is interrupted", async () => {
    const home = mkdtempSync(join(tmpdir(), "nlm-daemon-child-"));
    const port = await new Promise<number>((resolve, reject) => {
      const probe = createTcpServer();
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const address = probe.address();
        if (!address || typeof address === "string") return reject(new Error("no daemon port"));
        probe.close(() => resolve(address.port));
      });
    });
    const child = spawn(process.execPath, ["--import", "tsx", "src/cli/nlm.ts", "start", "--no-scheduler"], {
      cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"], env: {
        PATH: process.env["PATH"], HOME: home, NLM_DB_PATH: join(home, "canonical.sqlite"),
        NLM_PORT: String(port), NLM_MCP_TOKEN: "synthetic-test-token", NODE_OPTIONS: "--import=tsx",
        NLM_OLLAMA_URL: "http://127.0.0.1:9", NLM_LOOP_LOG: "0",
      },
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
    try {
      const deadline = Date.now() + 20_000;
      while (!stderr.includes("http listening") && child.exitCode === null && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
      expect(stderr).toContain("http listening");
      const response = await fetch(`http://127.0.0.1:${port}/api/jobs/reprocess`, {
        method: "POST", headers: { authorization: "Bearer synthetic-test-token", "content-type": "application/json" },
        body: JSON.stringify({ args: [] }),
      });
      expect(response.status).toBe(202);
      child.kill("SIGTERM");
      expect(await exited).toBe(1);
      expect(stderr).toContain("child job interrupted; reconcile state before handoff");
    } finally {
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
      rmSync(home, { recursive: true, force: true });
    }
  }, 40_000);

  it("handles SIGTERM during asynchronous daemon startup", async () => {
    const home = mkdtempSync(join(tmpdir(), "nlm-daemon-early-"));
    const preload = join(home, "early-signal.mjs");
    writeFileSync(preload, `
      const original = process.on;
      process.on = function(event, listener) {
        const result = original.call(this, event, listener);
        if (event === "SIGTERM" && listener.name === "earlyShutdown") {
          setImmediate(() => { process.stderr.write("fixture-early-signal\\n"); process.kill(process.pid, "SIGTERM"); });
        }
        return result;
      };
    `);
    const port = await new Promise<number>((resolve, reject) => {
      const probe = createTcpServer();
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const address = probe.address();
        if (!address || typeof address === "string") return reject(new Error("no daemon port"));
        probe.close(() => resolve(address.port));
      });
    });
    const database = join(home, "canonical.sqlite");
    const child = spawn(process.execPath, ["--import", "tsx", "src/cli/nlm.ts", "start", "--no-scheduler"], {
      cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"], env: {
        PATH: process.env["PATH"], HOME: home, NLM_DB_PATH: database, NLM_PORT: String(port),
        NLM_MCP_TOKEN: "synthetic-test-token", NODE_OPTIONS: `--import=${preload}`,
        NLM_OLLAMA_URL: "http://127.0.0.1:9", NLM_LOOP_LOG: "0",
      },
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
    try {
      expect(await exited).toBe(0);
      expect(stderr).toContain("fixture-early-signal");
      const db = new Database(database, { readonly: true });
      try { expect(db.pragma("quick_check", { simple: true })).toBe("ok"); }
      finally { db.close(); }
    } finally {
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
      rmSync(home, { recursive: true, force: true });
    }
  }, 40_000);
});
