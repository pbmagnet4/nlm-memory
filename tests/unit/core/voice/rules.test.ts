import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadVoiceRules, resolveRules, rulesVersion, voiceRules } from "../../../../src/core/voice/rules.js";
import { renderVoiceRulesSchema } from "../../../../scripts/gen-voice-rules-schema.js";

// Injectable faults for the fd read path: readSync (post-read size cap and
// read-failure caching) and closeSync (close-error swallowing). Pass-through
// unless a test arms them; reset in afterEach.
const fsState = vi.hoisted(() => ({
  readThrow: null as Error | null,
  readFillAll: false,
  closeThrow: null as Error | null,
}));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    readSync: (
      fd: number,
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number | null,
    ): number => {
      if (fsState.readThrow) throw fsState.readThrow;
      if (fsState.readFillAll) {
        buffer.fill(0x20, offset, offset + length);
        return length;
      }
      return fs.readSync(fd, buffer, offset, length, position);
    },
    closeSync: (fd: number): void => {
      if (fsState.closeThrow) throw fsState.closeThrow;
      return fs.closeSync(fd);
    },
  };
});

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "nlm-voice-rules-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  fsState.readThrow = null;
  fsState.readFillAll = false;
  fsState.closeThrow = null;
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function writeVoice(dir: string, voice: string, text: string): string {
  const path = join(dir, `${voice}.yaml`);
  writeFileSync(path, text);
  return path;
}

const VALID = `
voice: edward
rules: ["Plain words", "First person"]
banned_phrases: ["leverage", "game-changer"]
max_chars: 2000
channels:
  linkedin: { rules: ["One idea per post"], banned_phrases: ["leverage", "synergy"], max_chars: 1300 }
  email-professional: { rules: ["Lead with the ask"] }
audiences:
  client-blog: { rules: ["Name the client's reader"], max_chars: 500 }
`;

function harvestLog(): { lines: string[]; log: (m: string) => void } {
  const lines: string[] = [];
  return { lines, log: (m: string) => lines.push(m) };
}

describe("loadVoiceRules", () => {
  it("returns no rules (silently) for a missing dir or missing file", () => {
    const missingDir = join(tmp(), "nope");
    const { lines, log } = harvestLog();
    expect(loadVoiceRules(undefined, "edward", log)).toBeNull();
    expect(loadVoiceRules(missingDir, "edward", log)).toBeNull();
    expect(loadVoiceRules(tmp(), "edward", log)).toBeNull();
    expect(lines).toEqual([]);
  });

  it("rejects an unsafe voice name without touching the dir", () => {
    const dir = tmp();
    writeVoice(dir, "edward", VALID);
    const { lines, log } = harvestLog();
    for (const bad of ["Edward", "../edward", "a/b", "-x", "", "ed ward", "."]) {
      expect(loadVoiceRules(dir, bad, log)).toBeNull();
    }
    expect(lines).toEqual([]);
    expect(readdirSync(dir)).toEqual(["edward.yaml"]);
  });

  it("logs one WARN per file change for an invalid file, across repeated calls", () => {
    const dir = tmp();
    const path = writeVoice(dir, "edward", "voice: edward\nrules: [1, two]\n");
    const { lines, log } = harvestLog();
    expect(loadVoiceRules(dir, "edward", log)).toBeNull();
    expect(loadVoiceRules(dir, "edward", log)).toBeNull();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`[voice] WARN ${path}:`);
    expect(lines[0]).toContain("rules");

    // A file change arms the WARN again; the fix then loads, silently.
    writeVoice(dir, "edward", "voice: edward\nbanned_phrases: [3]\n");
    expect(loadVoiceRules(dir, "edward", log)).toBeNull();
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("banned_phrases.0");
    writeVoice(dir, "edward", VALID);
    expect(loadVoiceRules(dir, "edward", log)).not.toBeNull();
    expect(lines).toHaveLength(2);
  });

  it("logs a WARN for a file that is not valid YAML", () => {
    const dir = tmp();
    writeVoice(dir, "edward", "voice: [unclosed\n");
    const { lines, log } = harvestLog();
    expect(loadVoiceRules(dir, "edward", log)).toBeNull();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[voice] WARN");
  });

  it("re-reads when the file changes (content hash)", () => {
    const dir = tmp();
    writeVoice(dir, "edward", "voice: edward\nrules: [first]\n");
    expect(loadVoiceRules(dir, "edward")?.rules).toEqual(["first"]);
    writeVoice(dir, "edward", "voice: edward\nrules: [second, third]\n");
    expect(loadVoiceRules(dir, "edward")?.rules).toEqual(["second", "third"]);
  });

  it("detects a same-length edit within one mtime tick", () => {
    // A sha256 of the bytes catches what an mtime/size fingerprint misses.
    const dir = tmp();
    const path = writeVoice(dir, "edward", "voice: edward\nrules: [aaaa]\n");
    expect(loadVoiceRules(dir, "edward")?.rules).toEqual(["aaaa"]);
    const { atime, mtime } = statSync(path);
    writeVoice(dir, "edward", "voice: edward\nrules: [bbbb]\n"); // byte-length identical
    utimesSync(path, atime, mtime);
    expect(loadVoiceRules(dir, "edward")?.rules).toEqual(["bbbb"]);
  });

  it.skipIf(process.platform === "win32")("refuses a FIFO at <voice>.yaml without blocking", () => {
    const dir = tmp();
    const path = join(dir, "edward.yaml");
    execFileSync("mkfifo", [path]);
    const { lines, log } = harvestLog();
    expect(loadVoiceRules(dir, "edward", log)).toBeNull();
    expect(loadVoiceRules(dir, "edward", log)).toBeNull();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("not a regular file");
  });

  it("refuses a file that grew past the size cap during the read", () => {
    const dir = tmp();
    writeVoice(dir, "edward", VALID); // small: passes the fstat gate
    fsState.readFillAll = true; // the read comes back oversize
    const { lines, log } = harvestLog();
    expect(loadVoiceRules(dir, "edward", log)).toBeNull();
    expect(loadVoiceRules(dir, "edward", log)).toBeNull();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("exceeds");
  });

  it("caches a read failure so it warns once, not on every call", () => {
    const dir = tmp();
    writeVoice(dir, "edward", VALID);
    fsState.readThrow = Object.assign(new Error("EIO: i/o error, read"), { code: "EIO" });
    const { lines, log } = harvestLog();
    expect(loadVoiceRules(dir, "edward", log)).toBeNull();
    expect(loadVoiceRules(dir, "edward", log)).toBeNull();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("EIO");
    fsState.readThrow = null;
    expect(loadVoiceRules(dir, "edward", log)?.voice).toBe("edward");
    expect(lines).toHaveLength(1);
  });

  it("warns separately when the same code arrives with a different message", () => {
    const dir = tmp();
    writeVoice(dir, "edward", VALID);
    const { lines, log } = harvestLog();
    fsState.readThrow = Object.assign(new Error("EIO: i/o error, read"), { code: "EIO" });
    expect(loadVoiceRules(dir, "edward", log)).toBeNull();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("i/o error, read");
    fsState.readThrow = Object.assign(new Error("EIO: i/o error, write"), { code: "EIO" });
    expect(loadVoiceRules(dir, "edward", log)).toBeNull();
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("i/o error, write");
    expect(loadVoiceRules(dir, "edward", log)).toBeNull();
    expect(lines).toHaveLength(2);
    fsState.readThrow = null;
    expect(loadVoiceRules(dir, "edward", log)?.voice).toBe("edward");
    expect(lines).toHaveLength(2);
  });

  it("ignores a close error: the read result still resolves", () => {
    const dir = tmp();
    writeVoice(dir, "edward", VALID);
    fsState.closeThrow = Object.assign(new Error("EBADF: bad file descriptor, close"), { code: "EBADF" });
    const { lines, log } = harvestLog();
    expect(loadVoiceRules(dir, "edward", log)?.rules).toEqual(["Plain words", "First person"]);
    expect(loadVoiceRules(dir, "edward", log)?.rules).toEqual(["Plain words", "First person"]);
    expect(lines).toEqual([]);
    fsState.closeThrow = null;
    expect(loadVoiceRules(dir, "edward", log)?.rules).toEqual(["Plain words", "First person"]);
    expect(lines).toEqual([]);
  });

  it.skipIf(typeof process.getuid === "function" && process.getuid() === 0)(
    "logs and caches a non-ENOENT open failure (EACCES), silent ENOENT stays silent",
    () => {
      const dir = tmp();
      const path = writeVoice(dir, "edward", VALID);
      chmodSync(path, 0o000);
      try {
        const { lines, log } = harvestLog();
        expect(loadVoiceRules(dir, "edward", log)).toBeNull();
        expect(loadVoiceRules(dir, "edward", log)).toBeNull();
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain("EACCES");
        chmodSync(path, 0o600);
        expect(loadVoiceRules(dir, "edward", log)?.voice).toBe("edward");
        expect(lines).toHaveLength(1);
        // ENOENT: missing file, still no log.
        expect(loadVoiceRules(dir, "ghost", log)).toBeNull();
        expect(lines).toHaveLength(1);
      } finally {
        chmodSync(path, 0o600);
      }
    },
  );

  it("rejects unknown top-level keys (strict)", () => {
    const dir = tmp();
    writeVoice(dir, "edward", "voice: edward\ntone: casual\n");
    const { lines, log } = harvestLog();
    expect(loadVoiceRules(dir, "edward", log)).toBeNull();
    expect(lines[0]).toContain("[voice] WARN");
  });
});

describe("resolveRules", () => {
  it("concatenates rules voice → channel → audience", () => {
    const dir = tmp();
    writeVoice(dir, "edward", VALID);
    const file = loadVoiceRules(dir, "edward")!;
    expect(resolveRules(file, "linkedin", "client-blog").rules).toEqual([
      "Plain words",
      "First person",
      "One idea per post",
      "Name the client's reader",
    ]);
  });

  it("dedupes banned phrases preserving order", () => {
    const dir = tmp();
    writeVoice(dir, "edward", VALID);
    const file = loadVoiceRules(dir, "edward")!;
    expect(resolveRules(file, "linkedin").bannedPhrases).toEqual([
      "leverage",
      "game-changer",
      "synergy",
    ]);
  });

  it("takes the most specific defined max_chars", () => {
    const dir = tmp();
    writeVoice(dir, "edward", VALID);
    const file = loadVoiceRules(dir, "edward")!;
    expect(resolveRules(file, "unknown").maxChars).toBe(2000); // voice only
    expect(resolveRules(file, "linkedin").maxChars).toBe(1300); // channel over voice
    expect(resolveRules(file, "email-professional").maxChars).toBe(2000); // channel without one
    expect(resolveRules(file, "linkedin", "client-blog").maxChars).toBe(500); // audience wins
  });

  it("an unknown channel or audience contributes nothing", () => {
    const dir = tmp();
    writeVoice(dir, "edward", VALID);
    const file = loadVoiceRules(dir, "edward")!;
    expect(resolveRules(file, "no-such", "no-either")).toEqual({
      rules: ["Plain words", "First person"],
      bannedPhrases: ["leverage", "game-changer"],
      maxChars: 2000,
    });
  });

  it("prototype keys are not channels", () => {
    const dir = tmp();
    writeVoice(dir, "edward", VALID);
    const file = loadVoiceRules(dir, "edward")!;
    expect(resolveRules(file, "constructor").rules).toEqual(["Plain words", "First person"]);
  });
});

describe("voiceRules", () => {
  it("merges and reports the version in one call", () => {
    const dir = tmp();
    writeVoice(dir, "edward", VALID);
    const out = voiceRules(dir, "edward", "linkedin", "client-blog");
    expect(out).not.toBeNull();
    expect(out!.maxChars).toBe(500);
    expect(out!.rulesVersion).toBe("unversioned"); // mkdtemp dir, not a repo
    expect(voiceRules(dir, "ghost", "linkedin")).toBeNull();
    expect(voiceRules(undefined, "edward", "linkedin")).toBeNull();
  });

  it("passes the invalid-file WARN through voiceRules, once per change", () => {
    const dir = tmp();
    writeVoice(dir, "edward", "voice: edward\nmax_chars: 0\n");
    const { lines, log } = harvestLog();
    expect(voiceRules(dir, "edward", "linkedin", undefined, log)).toBeNull();
    expect(voiceRules(dir, "edward", "linkedin", undefined, log)).toBeNull();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[voice] WARN");
  });
});

function gitIn(dir: string, args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  });
}

function gitInitCommitted(dir: string): void {
  gitIn(dir, ["init", "-q"]);
  writeFileSync(join(dir, "edward.yaml"), VALID);
  gitIn(dir, ["add", "edward.yaml"]);
  gitIn(dir, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);
}

describe("rulesVersion", () => {
  it("is the short HEAD in a clean repo", () => {
    const dir = tmp();
    gitInitCommitted(dir);
    expect(rulesVersion(dir)).toMatch(/^[0-9a-f]{7,}$/);
    expect(rulesVersion(dir)).toBe(gitIn(dir, ["rev-parse", "--short", "HEAD"]).trim());
  });

  it("is suffixed -dirty when tracked files change, not when untracked files appear", () => {
    const dir = tmp();
    gitInitCommitted(dir);
    writeFileSync(join(dir, "scratch.txt"), "untracked\n");
    expect(rulesVersion(dir, 0)).not.toContain("-dirty"); // ttl 0: check git, not the cache
    writeFileSync(join(dir, "edward.yaml"), VALID + "\n");
    expect(rulesVersion(dir, 0)).toBe(`${gitIn(dir, ["rev-parse", "--short", "HEAD"]).trim()}-dirty`);
  });

  it("is 'unversioned' outside a git repo (and for an empty repo)", () => {
    expect(rulesVersion(tmp())).toBe("unversioned");
    const bare = tmp();
    gitIn(bare, ["init", "-q"]);
    expect(rulesVersion(bare)).toBe("unversioned");
  });

  it("refreshes after the cache TTL, not before", () => {
    const dir = tmp();
    gitInitCommitted(dir);
    const head1 = gitIn(dir, ["rev-parse", "--short", "HEAD"]).trim();
    let now = 1_000_000;
    const clock = () => now;
    expect(rulesVersion(dir, 60_000, clock)).toBe(head1);
    writeFileSync(join(dir, "edward.yaml"), VALID + "\n");
    gitIn(dir, ["add", "edward.yaml"]);
    gitIn(dir, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "second"]);
    const head2 = gitIn(dir, ["rev-parse", "--short", "HEAD"]).trim();
    expect(head2).not.toBe(head1);
    expect(rulesVersion(dir, 60_000, clock)).toBe(head1); // TTL not expired
    now += 60_001;
    expect(rulesVersion(dir, 60_000, clock)).toBe(head2);
    writeFileSync(join(dir, "edward.yaml"), VALID + "x"); // dirty a tracked file
    expect(rulesVersion(dir, 60_000, clock)).toBe(head2); // still TTL-cached
    now += 60_001;
    expect(rulesVersion(dir, 60_000, clock)).toBe(`${head2}-dirty`);
  });

  it("refreshes rules on file change while the version stays TTL-cached", () => {
    const dir = tmp();
    gitInitCommitted(dir);
    const head = gitIn(dir, ["rev-parse", "--short", "HEAD"]).trim();
    expect(voiceRules(dir, "edward", "linkedin")!.rulesVersion).toBe(head);
    writeFileSync(join(dir, "edward.yaml"), VALID.replace("First person", "Second person"));
    const out = voiceRules(dir, "edward", "linkedin")!;
    expect(out.rules).toContain("Second person"); // rules refresh immediately
    expect(out.rulesVersion).toBe(head); // version lags by up to the 60 s TTL
  });

  it("evicts the oldest dir once more than 64 dirs are cached", () => {
    const dir1 = tmp();
    gitInitCommitted(dir1);
    const head1 = gitIn(dir1, ["rev-parse", "--short", "HEAD"]).trim();
    const future = Date.now() + 3_600_000; // expires other tests' entries on first write
    const clock = () => future;
    expect(rulesVersion(dir1, 60_000, clock)).toBe(head1);
    writeFileSync(join(dir1, "edward.yaml"), VALID.replace("First person", "Second person"));
    gitIn(dir1, ["add", "edward.yaml"]);
    gitIn(dir1, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "second"]);
    const head2 = gitIn(dir1, ["rev-parse", "--short", "HEAD"]).trim();
    expect(head2).not.toBe(head1);
    for (let i = 0; i < 64; i++) {
      expect(rulesVersion(tmp(), 60_000, clock)).toBe("unversioned");
    }
    // dir1 was the oldest entry: evicted despite its TTL not having expired,
    // so its new head is visible immediately.
    expect(rulesVersion(dir1, 60_000, clock)).toBe(head2);
  });
});

describe("schemas/voice-rules.schema.json", () => {
  it("equals the regenerated zod schema", () => {
    const committed = readFileSync(new URL("../../../../schemas/voice-rules.schema.json", import.meta.url), "utf8");
    expect(renderVoiceRulesSchema()).toBe(committed);
    expect(existsSync(new URL("../../../../schemas/voice-rules.schema.json", import.meta.url))).toBe(true);
  });
});
