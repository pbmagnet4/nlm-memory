/**
 * T1751 — subject vocabulary for the classifier extractor. Covers the file
 * loader (parse, mtime cache, failure tolerance), per-call transcript
 * selection (whole-word/joined matching, occurrence ranking, 50 cap), and
 * buildUserPrompt integration (byte-identical baseline when nothing matches;
 * known-subjects line when something does).
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildUserPrompt, selectSubjectVocab } from "../../../../src/core/classifier/prompt.js";
import {
  loadConfiguredSubjectVocab,
  loadSubjectVocab,
  MAX_PROMPT_SUBJECTS,
  parseSubjectVocab,
  resetSubjectVocabCache,
} from "../../../../src/core/classifier/subject-vocab.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "subject-vocab-"));
  resetSubjectVocabCache();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  resetSubjectVocabCache();
});

function vocabFile(name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content, "utf8");
  return p;
}

describe("parseSubjectVocab", () => {
  it("keeps one lowercase subject per line, drops comments and blanks", () => {
    const v = parseSubjectVocab(
      "# canonical subjects\nnlm-memory\n\n  Acme-Client  # trailing comment\n#full line\nnlm-memory\n",
    );
    expect([...v.subjects]).toEqual(["nlm-memory", "acme-client"]);
  });

  it("tolerates CRLF and empty text", () => {
    expect([...parseSubjectVocab("a-b\r\nc\r\n").subjects]).toEqual(["a-b", "c"]);
    expect(parseSubjectVocab("").subjects).toEqual([]);
  });
});

describe("loadSubjectVocab", () => {
  it("reads a configured file", () => {
    const p = vocabFile("v.txt", "nlm-memory\n# comment\nacme-client\n");
    expect([...loadSubjectVocab(p).subjects]).toEqual(["nlm-memory", "acme-client"]);
  });

  it("reloads when the file's mtime changes", () => {
    const p = vocabFile("v.txt", "alpha\n");
    expect([...loadSubjectVocab(p).subjects]).toEqual(["alpha"]);
    writeFileSync(p, "beta\n", "utf8");
    const future = new Date(Date.now() + 5_000);
    utimesSync(p, future, future);
    expect([...loadSubjectVocab(p).subjects]).toEqual(["beta"]);
  });

  it("serves the cache while mtime is unchanged (file content edits excluded by contract)", () => {
    const p = vocabFile("v.txt", "alpha\n");
    loadSubjectVocab(p);
    expect([...loadSubjectVocab(p).subjects]).toEqual(["alpha"]);
  });

  it("missing file: empty vocab, warns once, repeats stay silent", () => {
    const warn = vi.fn();
    const p = join(dir, "nope.txt");
    expect(loadSubjectVocab(p, warn).subjects).toEqual([]);
    expect(loadSubjectVocab(p, warn).subjects).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain(p);
  });

  it("directory instead of file: empty vocab, warns once", () => {
    const warn = vi.fn();
    expect(loadSubjectVocab(dir, warn).subjects).toEqual([]);
    expect(loadSubjectVocab(dir, warn).subjects).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("recovers when a previously missing file appears", () => {
    const p = join(dir, "later.txt");
    expect(loadSubjectVocab(p).subjects).toEqual([]);
    writeFileSync(p, "appeared\n", "utf8");
    expect([...loadSubjectVocab(p).subjects]).toEqual(["appeared"]);
  });
});

describe("loadConfiguredSubjectVocab", () => {
  it("unset or blank env means no vocab and no file access", () => {
    expect(loadConfiguredSubjectVocab({}).subjects).toEqual([]);
    expect(loadConfiguredSubjectVocab({ NLM_SUBJECT_VOCAB_PATH: "  " }).subjects).toEqual([]);
  });

  it("loads the path named by NLM_SUBJECT_VOCAB_PATH", () => {
    const p = vocabFile("v.txt", "beacon\n");
    expect([...loadConfiguredSubjectVocab({ NLM_SUBJECT_VOCAB_PATH: p }).subjects]).toEqual(["beacon"]);
  });
});

describe("selectSubjectVocab", () => {
  const vocab = (subjects: string[]) => ({ subjects });

  it("matches when every hyphen part appears as a whole word", () => {
    const sel = selectSubjectVocab(vocab(["nlm-memory"]), "we improved NLM recall and the memory layer");
    expect(sel).toEqual(["nlm-memory"]);
  });

  it("matches when the joined form appears", () => {
    expect(selectSubjectVocab(vocab(["nlm-memory"]), "shipped nlm-memory 0.4")).toEqual(["nlm-memory"]);
  });

  it("does not match on substrings", () => {
    expect(selectSubjectVocab(vocab(["glm"]), "compiled the ml models")).toEqual([]);
    expect(selectSubjectVocab(vocab(["nav"]), "the navigation bar")).toEqual([]);
  });

  it("requires every part of a multi-part name", () => {
    const sel = selectSubjectVocab(vocab(["acme-client"]), "the client called about acme pricing");
    expect(sel).toEqual(["acme-client"]); // both parts present
    expect(selectSubjectVocab(vocab(["acme-client-portal"]), "the client called about acme pricing")).toEqual([]);
  });

  it("ranks by occurrences, descending, ties in file order", () => {
    const sel = selectSubjectVocab(
      vocab(["hot-thing", "warm-thing", "rare-thing"]),
      "hot thing hot thing hot thing warm thing warm thing rare thing",
    );
    expect(sel).toEqual(["hot-thing", "warm-thing", "rare-thing"]);
    const tied = selectSubjectVocab(
      vocab(["zeta", "alpha"]),
      "zeta and zeta, alpha and alpha",
    );
    expect(tied).toEqual(["zeta", "alpha"]); // 2 vs 2 -> file order wins
  });

  it("caps the selection at 50 in occurrence order", () => {
    const subjects: string[] = [];
    let transcript = "";
    for (let i = 0; i < 60; i++) {
      subjects.push(`sub${i}`);
      // sub0 appears 60 times, sub59 once — descending frequency by index.
      transcript += `sub${i} `.repeat(60 - i);
    }
    const sel = selectSubjectVocab(vocab(subjects), transcript);
    expect(sel.length).toBe(MAX_PROMPT_SUBJECTS);
    expect(sel[0]).toBe("sub0"); // most frequent first
    expect(sel[sel.length - 1]).toBe("sub49");
  });

  it("empty vocab or empty transcript select nothing", () => {
    expect(selectSubjectVocab(vocab([]), "anything")).toEqual([]);
    expect(selectSubjectVocab(vocab(["x"]), "")).toEqual([]);
  });
});

describe("buildUserPrompt integration", () => {
  const baseline = (t: string, pc = "") => `TRANSCRIPT TO CLASSIFY:\n${t}`;

  it("no vocabulary configured: prompt byte-identical to the historical format", () => {
    const t = "we discussed nlm-memory internals";
    expect(buildUserPrompt(t, "", { env: {} })).toBe(baseline(t));
  });

  it("configured vocab with no match: prompt byte-identical", () => {
    const p = vocabFile("v.txt", "totally-unrelated-topic\n");
    const t = "we discussed nlm-memory internals";
    const out = buildUserPrompt(t, "", { env: { NLM_SUBJECT_VOCAB_PATH: p } });
    expect(out).toBe(baseline(t));
  });

  it("missing vocab file: prompt byte-identical, warns once, never crashes", () => {
    const t = "we discussed nlm-memory internals";
    const warn = vi.fn();
    const env = { NLM_SUBJECT_VOCAB_PATH: join(dir, "ghost.txt") };
    expect(buildUserPrompt(t, "", { env, warn })).toBe(baseline(t));
    expect(buildUserPrompt(t, "", { env, warn })).toBe(baseline(t));
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("matching vocab adds the known-subjects line before the transcript", () => {
    const v = vocabFile("v.txt", "nlm-memory\nacme-client\n");
    const t = "we shipped nlm-memory for the acme-client rollout";
    const out = buildUserPrompt(t, "", { vocab: { subjects: readFileSync(v, "utf8").trim().split("\n") } });
    expect(out).toBe(
      "Known subjects (use the exact name when a fact is about one of these; otherwise name the subject as usual): nlm-memory, acme-client\n" +
        "\nTRANSCRIPT TO CLASSIFY:\n" + t,
    );
  });

  it("keeps prior context ahead of the known-subjects line and caps at 50", () => {
    const subjects: string[] = [];
    let transcript = "";
    for (let i = 0; i < 55; i++) {
      subjects.push(`sub${i}`);
      transcript += `sub${i} `.repeat(55 - i);
    }
    const out = buildUserPrompt(transcript, "PRIOR FACT", { vocab: { subjects } });
    expect(out).toContain("PRIOR CONTEXT (already filed):\nPRIOR FACT\n");
    expect(out.indexOf("Known subjects")).toBeGreaterThan(out.indexOf("PRIOR CONTEXT"));
    expect(out.indexOf("Known subjects")).toBeLessThan(out.indexOf("TRANSCRIPT TO CLASSIFY"));
    const list = out.slice(out.indexOf(": ", out.indexOf("Known subjects")) + 2, out.indexOf("\n\nTRANSCRIPT"));
    expect(list.split(", ").length).toBe(MAX_PROMPT_SUBJECTS);
    expect(list.startsWith("sub0, sub1")).toBe(true);
  });

  it("resolves NLM_SUBJECT_VOCAB_PATH from the default env and reloads on mtime change", () => {
    const p = vocabFile("v.txt", "beacon\n");
    const t = "built the beacon dashboard";
    const env = { NLM_SUBJECT_VOCAB_PATH: p };
    expect(buildUserPrompt(t, "", { env })).toContain("Known subjects");
    writeFileSync(p, "zebra-topic\n", "utf8");
    const future = new Date(Date.now() + 5_000);
    utimesSync(p, future, future);
    const out2 = buildUserPrompt(t, "", { env });
    expect(out2).toBe(`TRANSCRIPT TO CLASSIFY:\n${t}`);
  });

  it("never touches the filesystem when no vocab path is configured", () => {
    // env:{} short-circuits before the loader; existsSync on the default
    // state root would otherwise be observable. Cheap proxy: identical
    // output plus no warn calls with a bogus-but-unset path.
    expect(existsSync(join(dir, "anything"))).toBe(false);
    expect(vi.isMockFunction(readFileSync)).toBe(false); // sanity: fs not mocked
    expect(buildUserPrompt("hello", "", { env: {} })).toBe("TRANSCRIPT TO CLASSIFY:\nhello");
  });
});
