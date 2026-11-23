/**
 * The daemon with the voice lane on and off (T2438 piece C).
 *
 * Unit tests already cover the endpoint and the sweep function; this is the
 * wiring those cannot see: that `nlm start` hands the writing-sample store to
 * the HTTP app at all, that the retry sweep is registered only while the flag
 * is on, and that a flag-off install answers 404 rather than half-serving the
 * route. One boot per flag state, waiting for the same readiness line the
 * shutdown test waits for, with both model lanes pointed at a closed port so a
 * test never reaches a live embedder.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer as createTcpServer } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const VOICE_SAMPLE = JSON.stringify({
  voice: "edward",
  channel: "linkedin",
  text: "Automation is a documentation problem, not a tooling problem.",
  outcome: "published",
  ts: "2026-11-20T09:00:00.000Z",
});

interface RunningDaemon {
  readonly port: number;
  readonly stderr: () => string;
  readonly stop: () => Promise<void>;
}

async function bootVoiceDaemon(extraEnv: Record<string, string>): Promise<RunningDaemon> {
  const home = mkdtempSync(join(tmpdir(), "nlm-voice-daemon-"));
  const port = await new Promise<number>((res, rej) => {
    const probe = createTcpServer();
    probe.once("error", rej);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address && typeof address === "object") probe.close(() => res(address.port));
      else rej(new Error("no test port"));
    });
  });

  const child = spawn(process.execPath, ["--import", "tsx", "src/cli/nlm.ts", "start", "--no-scheduler"], {
    cwd: process.cwd(),
    env: {
      PATH: process.env["PATH"],
      HOME: home,
      NLM_STATE_ROOT: home,
      NLM_DB_PATH: join(home, "canonical.sqlite"),
      NLM_PORT: String(port),
      NLM_CLASSIFIER_BASE_URL: "http://127.0.0.1:9",
      NLM_OLLAMA_URL: "http://127.0.0.1:9",
      NLM_LOOP_LOG: "0",
      NLM_ADAPTERS: "__none__",
      ...extraEnv,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

  const deadline = Date.now() + 30_000;
  while (!stderr.includes("http listening") && child.exitCode === null && Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, 25));
  }
  if (!stderr.includes("http listening")) {
    child.kill("SIGKILL");
    rmSync(home, { recursive: true, force: true });
    throw new Error(`daemon never came up: ${stderr.slice(-1200)}`);
  }

  return {
    port,
    stderr: () => stderr,
    stop: async () => {
      child.kill("SIGTERM");
      await new Promise((res) => child.once("exit", res));
      rmSync(home, { recursive: true, force: true });
    },
  };
}

function postSample(port: number): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/voice/sample`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: VOICE_SAMPLE,
  });
}

describe("nlm start with the voice lane on", () => {
  let daemon: RunningDaemon;
  beforeAll(async () => {
    daemon = await bootVoiceDaemon({ NLM_VOICE_ENABLED: "1" });
  }, 60_000);
  afterAll(async () => {
    await daemon.stop();
  });

  it("serves intake off the daemon's own store wiring", async () => {
    const res = await postSample(daemon.port);
    // 201 rather than 503 is the point: HttpDeps.writingSampleStore is wired.
    // The embedder is unreachable here (port 9) and that must not leak into the
    // response — the row simply waits for the sweep.
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ skipped: false });
  }, 30_000);

  it("registers the retry sweep alongside the other embed sweeps", () => {
    expect(daemon.stderr()).toContain("voice-embed-sweep: enabled, retry sweep every 2m");
    expect(daemon.stderr()).toContain("chunk-embed-sweep: enabled");
  });
});

describe("nlm start with the voice lane off", () => {
  let daemon: RunningDaemon;
  beforeAll(async () => {
    daemon = await bootVoiceDaemon({});
  }, 60_000);
  afterAll(async () => {
    await daemon.stop();
  });

  it("answers 404 and starts no voice sweep", async () => {
    expect((await postSample(daemon.port)).status).toBe(404);
    expect(daemon.stderr()).not.toContain("voice-embed-sweep");
    expect(daemon.stderr()).toContain("http listening");
  }, 30_000);
});
