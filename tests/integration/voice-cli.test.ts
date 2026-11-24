/**
 * `nlm voice-signal`, `nlm voice backfill` and `nlm voice retire` end to end
 * through the real command definitions (T2438 piece C, design §C3/§C4).
 *
 * Spawned, because the properties that matter to a hook caller — a down
 * daemon exits 0 for the best-effort producers but exits 1 for retire, and
 * --dry-run reaches no socket at all — only exist at the process boundary.
 * Every spawn points NLM_PORT at a port nothing listens on, so a missing
 * --dry-run would show up as a connection error rather than silently writing
 * to a live daemon.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createServer as createHttpServer, type ServerResponse } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CLI = "src/cli/nlm.ts";
const MD = resolve("tests/fixtures/voice/md");

let home: string;
let deadPort: number;
const dirs: string[] = [];

/** An OS-assigned port that is released before use, so connecting fails fast. */
async function unusedPort(): Promise<number> {
  const probe = createTcpServer();
  await new Promise<void>((res, rej) => {
    probe.once("error", rej);
    probe.listen(0, "127.0.0.1", () => res());
  });
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("no test port");
  const port = address.port;
  await new Promise<void>((res) => probe.close(() => res()));
  return port;
}

function runNlm(args: string[], extraEnv: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, ["--import", "tsx", CLI, ...args], {
      cwd: process.cwd(),
      env: {
        PATH: process.env["PATH"],
        HOME: home,
        NLM_STATE_ROOT: home,
        NLM_PORT: String(deadPort),
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", rejectRun);
    child.once("exit", (code) => resolveRun({ code, stdout, stderr }));
  });
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "nlm-voice-cli-"));
  dirs.push(home);
  deadPort = await unusedPort();
});

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("nlm voice-signal", () => {
  it("prints the payload and reaches no socket on --dry-run", async () => {
    const { code, stdout, stderr } = await runNlm([
      "voice-signal",
      "--voice", "edward",
      "--channel", "linkedin",
      "--text", "Plain words, one idea.",
      "--url", "https://whtnxt.com/two-files",
      "--outcome", "approved",
      "--draft-id", "draft-7",
      "--dry-run",
    ]);

    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      voice: "edward",
      channel: "linkedin",
      text: "Plain words, one idea.",
      outcome: "approved",
      source_ref: "https://whtnxt.com/two-files",
      draft_id: "draft-7",
      ts: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
  }, 60_000);

  it("reads --text-file, without the file's trailing newline", async () => {
    const { code, stdout } = await runNlm([
      "voice-signal",
      "--voice", "edward",
      "--channel", "linkedin",
      "--text-file", join(MD, "2026-01-06-no-frontmatter.md"),
      "--dry-run",
    ]);

    expect(code).toBe(0);
    expect(JSON.parse(stdout).text).toBe(
      "A note exported without any frontmatter at all. The whole file is the text.",
    );
  }, 60_000);

  it("warns once on stderr and exits 0 when the daemon is down", async () => {
    const { code, stdout, stderr } = await runNlm([
      "voice-signal",
      "--voice", "edward",
      "--channel", "linkedin",
      "--text", "Plain words, one idea.",
    ]);

    expect(code).toBe(0);
    expect(stdout).toBe("");
    expect(stderr.trim().split("\n")).toHaveLength(1);
    expect(stderr).toMatch(/voice-signal:.*not listening on 127\.0\.0\.1:/);
  }, 60_000);

  it("refuses to run without text", async () => {
    const { code, stderr } = await runNlm([
      "voice-signal",
      "--voice", "edward",
      "--channel", "linkedin",
      "--dry-run",
    ]);

    expect(code).not.toBe(0);
    expect(stderr).toMatch(/--text/);
  }, 60_000);

  it("refuses --text together with --text-file", async () => {
    const { code, stderr } = await runNlm([
      "voice-signal",
      "--voice", "edward",
      "--channel", "linkedin",
      "--text", "one",
      "--text-file", join(MD, "2026-01-06-no-frontmatter.md"),
      "--dry-run",
    ]);

    expect(code).not.toBe(0);
    expect(stderr).toMatch(/not both/);
  }, 60_000);

  it("refuses an outcome the endpoint would only reject later", async () => {
    const { code, stderr } = await runNlm([
      "voice-signal",
      "--voice", "edward",
      "--channel", "linkedin",
      "--text", "Plain words, one idea.",
      "--outcome", "shipped",
      "--dry-run",
    ]);

    expect(code).not.toBe(0);
    expect(stderr).toMatch(/--outcome/);
  }, 60_000);

  it("says so, in one line, when --text-file is not there", async () => {
    const { code, stdout, stderr } = await runNlm([
      "voice-signal",
      "--voice", "edward",
      "--channel", "linkedin",
      "--text-file", join(MD, "no-such-post.md"),
    ]);

    expect(code).not.toBe(0);
    expect(stdout).toBe("");
    expect(stderr.trim().split("\n")).toHaveLength(1);
    expect(stderr).toMatch(/cannot read .*no-such-post\.md/);
  }, 60_000);

  it("reports what a daemon that refuses the sample said, and still exits 0", async () => {
    const seen: string[] = [];
    const stub = createHttpServer((req, res: ServerResponse) => {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.once("end", () => {
        seen.push(body);
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "text exceeds 20000 characters" }));
      });
    });
    const port = await new Promise<number>((res) => stub.listen(0, "127.0.0.1", () => {
      const address = stub.address();
      if (address && typeof address === "object") res(address.port);
    }));

    try {
      const { code, stdout, stderr } = await runNlm([
        "voice-signal",
        "--voice", "edward",
        "--channel", "linkedin",
        "--text", "Too long by the daemon's reckoning.",
      ], { NLM_PORT: String(port) });

      expect(code).toBe(0);
      expect(stdout).toBe("");
      expect(stderr.trim().split("\n")).toHaveLength(1);
      expect(stderr).toContain("text exceeds 20000 characters");
      expect(JSON.parse(seen[0]!)).toMatchObject({
        voice: "edward",
        channel: "linkedin",
        outcome: "published",
        text: "Too long by the daemon's reckoning.",
      });
    } finally {
      await new Promise<void>((res) => stub.close(() => res()));
    }
  }, 60_000);
});

describe("nlm voice backfill", () => {
  it("prints counts only, and stores nothing on --dry-run", async () => {
    const { code, stdout, stderr } = await runNlm([
      "voice", "backfill", "markdown-dir", MD,
      "--voice", "edward",
      "--channel", "linkedin",
      "--dry-run",
    ]);

    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ read: 4, stored: 0, skipped: 1, rejected: 1 });
  }, 60_000);

  it("counts every rejection with the daemon down instead of storing anything", async () => {
    const { code, stdout, stderr } = await runNlm([
      "voice", "backfill", "jsonl", resolve("tests/fixtures/voice/posts.jsonl"),
      "--voice", "edward",
    ]);

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ read: 3, stored: 0, skipped: 0, rejected: 11 });
    expect(stderr).toMatch(/3 row\(s\) never reached the daemon at http:\/\/127\.0\.0\.1:/);
  }, 60_000);

  it("insists on --channel for a directory of files", async () => {
    const { code, stderr } = await runNlm([
      "voice", "backfill", "markdown-dir", MD,
      "--voice", "edward",
    ]);

    expect(code).not.toBe(0);
    expect(stderr).toMatch(/--channel/);
  }, 60_000);

  it("reports an unknown format instead of doing nothing quietly", async () => {
    const { code, stderr } = await runNlm([
      "voice", "backfill", "csv", MD,
      "--voice", "edward",
      "--channel", "linkedin",
    ]);

    expect(code).not.toBe(0);
    expect(stderr).toMatch(/csv/);
  }, 60_000);
});

/** A stub daemon answering POST /api/voice/retire, recording every body it saw. */
function stubRetireDaemon(
  onResponse: (refs: string[]) => { status: number; body: unknown },
): Promise<{ port: number; bodies: unknown[]; close(): Promise<void> }> {
  const bodies: unknown[] = [];
  const stub = createHttpServer((req, res: ServerResponse) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => { raw += chunk.toString(); });
    req.once("end", () => {
      const parsed = JSON.parse(raw) as { refs?: unknown };
      const refs = Array.isArray(parsed.refs) ? (parsed.refs as string[]) : [];
      bodies.push(parsed);
      const { status, body } = onResponse(refs);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  return new Promise((open) => {
    stub.listen(0, "127.0.0.1", () => {
      const address = stub.address();
      if (!address || typeof address === "string") throw new Error("no test port");
      open({ port: address.port, bodies, close: () => new Promise<void>((res) => stub.close(() => res())) });
    });
  });
}

describe("nlm voice retire", () => {
  it("counts the refs and posts nothing on --dry-run, even against a live daemon", async () => {
    const stub = await stubRetireDaemon(() => ({ status: 200, body: { retired: 99 } }));
    try {
      const { code, stdout, stderr } = await runNlm(
        ["voice", "retire", "--ref", "email:1001", "--ref", "email:1002", "--dry-run"],
        { NLM_PORT: String(stub.port) },
      );
      expect(code).toBe(0);
      expect(stderr).toBe("");
      expect(JSON.parse(stdout)).toEqual({ requested: 2, retired: 0 });
      expect(stub.bodies).toHaveLength(0);
    } finally {
      await stub.close();
    }
  }, 60_000);

  it("posts batches of 500 and totals what the daemon retired", async () => {
    const file = join(home, "many-refs.txt");
    writeFileSync(
      file,
      Array.from({ length: 1_199 }, (_, i) => `email:${i}`).join("\n") + "\n\n   spaced:ref   \n\n",
      "utf8",
    );
    const stub = await stubRetireDaemon((batch) => ({ status: 200, body: { retired: batch.length } }));
    try {
      const { code, stdout, stderr } = await runNlm(
        ["voice", "retire", "--refs-file", file],
        { NLM_PORT: String(stub.port) },
      );
      expect(code).toBe(0);
      expect(stderr).toBe("");
      expect(JSON.parse(stdout)).toEqual({ requested: 1_200, retired: 1_200 });
      const batches = stub.bodies.map((b) => (b as { refs: string[] }).refs);
      expect(batches.map((refs) => refs.length)).toEqual([500, 500, 200]);
      expect(batches.flat()).toContain("spaced:ref");
    } finally {
      await stub.close();
    }
  }, 60_000);

  it("exits 1 with one stderr line when the daemon is down", async () => {
    const { code, stdout, stderr } = await runNlm(["voice", "retire", "--ref", "email:1001"]);

    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr.trim().split("\n")).toHaveLength(1);
    expect(stderr).toMatch(/voice retire:.*not listening on 127\.0\.0\.1:/);
  }, 60_000);

  it("exits 1 quoting a daemon that refused the batch", async () => {
    const stub = await stubRetireDaemon(() => ({ status: 400, body: { error: "refs: Array must contain at least 1 element(s)" } }));
    try {
      const { code, stdout, stderr } = await runNlm(
        ["voice", "retire", "--ref", "email:1001"],
        { NLM_PORT: String(stub.port) },
      );
      expect(code).toBe(1);
      expect(stdout).toBe("");
      expect(stderr.trim().split("\n")).toHaveLength(1);
      expect(stderr).toMatch(/voice retire:.*400/);
      expect(stderr).toContain("refs");
    } finally {
      await stub.close();
    }
  }, 60_000);

  it("refuses --ref together with --refs-file", async () => {
    const { code, stderr } = await runNlm(["voice", "retire", "--ref", "email:1", "--refs-file", join(home, "x.txt")]);

    expect(code).not.toBe(0);
    expect(stderr).toMatch(/not both/);
  }, 60_000);

  it("refuses to run with no refs", async () => {
    const { code, stderr } = await runNlm(["voice", "retire"]);

    expect(code).not.toBe(0);
    expect(stderr).toMatch(/--ref/);
  }, 60_000);

  it("says so, in one line, when --refs-file is not there", async () => {
    const { code, stdout, stderr } = await runNlm(["voice", "retire", "--refs-file", join(home, "no-such-refs.txt")]);

    expect(code).not.toBe(0);
    expect(stdout).toBe("");
    expect(stderr.trim().split("\n")).toHaveLength(1);
    expect(stderr).toMatch(/cannot read .*no-such-refs\.txt/);
  }, 60_000);
});
