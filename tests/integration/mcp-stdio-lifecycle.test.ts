import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { expect, it } from "vitest";

it.each(["eof", "server", "transport", "repeated", "startup-create", "startup-connect"])(
  "stdio owner reaps workers and exits normally on %s", async (mode) => {
    const repo = resolve(".");
    const dir = mkdtempSync(join(tmpdir(), "nlm-stdio-lifecycle-"));
    for (const name of ["home", "state", "config", "cache", "data"]) mkdirSync(join(dir, name));
    const child = spawn(process.execPath, ["--import", "tsx", "tests/fixtures/mcp-stdio-child.mjs", repo, join(dir, "test.sqlite"), mode, process.env["NLM_STDIO_TEST_COMPILED"] === "1" ? "dist" : "src"], {
      cwd: repo, stdio: ["pipe", "pipe", "pipe"], env: {
        PATH: process.env.PATH, HOME: join(dir, "home"), NLM_STATE_ROOT: join(dir, "state"),
        XDG_CONFIG_HOME: join(dir, "config"), XDG_CACHE_HOME: join(dir, "cache"), XDG_DATA_HOME: join(dir, "data"),
        NLM_RECALL_REWRITE_DEFAULT: "false", TSX_TSCONFIG_PATH: join(repo, "tsconfig.json"),
      },
    });
    let stderr = ""; let fixture: Record<string, unknown> | undefined;
    const responses = new Map<number, (value: any) => void>();
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      const data = JSON.parse(line);
      if (data.fixture) fixture = data;
      else if (data.id !== undefined) responses.get(data.id)?.(data);
    });
    const exited = new Promise<{ code: number | null; signal: string | null }>((done) => child.on("exit", (code, signal) => done({ code, signal })));
    const request = (id: number, method: string, params: object) => new Promise<any>((done) => {
      responses.set(id, done); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const within = async <T>(operation: Promise<T>, ms: number) => {
      try { return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`child did not finish: ${stderr}`)), ms); })]); }
      finally { clearTimeout(timer); }
    };
    try {
      if (!mode.startsWith("startup")) {
        await within(request(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "fixture", version: "1" } }), 10_000);
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
        const result = await within(request(2, "tools/call", { name: "recall_context", arguments: { query: "fixture", mode: "hybrid" } }), 10_000);
        expect(result.result.isError).not.toBe(true);
        expect(JSON.parse(result.result.content[0].text).coverage).toMatchObject({ facts: "complete", sessions: "complete" });
        if (mode === "eof") child.stdin.end();
        else await within(request(3, "tools/call", { name: "fixture_close", arguments: {} }), 2_000);
      }
      expect(await within(exited, 3_000)).toEqual({ code: 0, signal: null });
      expect(fixture?.closes).toBe(1);
      expect(fixture?.signalListeners).toEqual({ SIGINT: 0, SIGTERM: 0 });
      expect(fixture?.inputListeners).toEqual([0, 0, 0, 0]);
      if (mode.startsWith("startup")) expect(fixture?.failure).toContain("fixture startup");
      else { expect(fixture?.reads).toBe(2); expect(fixture?.failure).toBeUndefined(); }
    } finally {
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
      lines.close(); rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000,
);
