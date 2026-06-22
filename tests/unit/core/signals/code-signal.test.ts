import { describe, expect, it } from "vitest";
import { buildCodeSignalPayload } from "../../../../src/core/signals/code-signal.js";

const NOW = () => "2026-06-09T12:00:00.000Z";

// Synthetic multi-hunk diff: a small 1-line hunk in utils.py and a larger
// multi-line hunk in src/calc.ts. The TS hunk has more added lines, so it
// must win the largest-hunk selection.
const FIXTURE_DIFF = `diff --git a/utils.py b/utils.py
index 1111111..2222222 100644
--- a/utils.py
+++ b/utils.py
@@ -1,3 +1,4 @@ def helper():
 import os
+    return os.getcwd()
 # trailing
diff --git a/src/calc.ts b/src/calc.ts
index 3333333..4444444 100644
--- a/src/calc.ts
+++ b/src/calc.ts
@@ -10,4 +10,9 @@ export function add(a: number, b: number) {
   const total = a + b;
+  if (Number.isNaN(total)) {
+    throw new Error("NaN result");
+  }
+  const doubled = total * 2;
+  const tripled = total * 3;
   return total;
 }
`;

describe("buildCodeSignalPayload", () => {
  it("selects the largest hunk by added-line count and extracts its added lines", () => {
    const p = buildCodeSignalPayload({ repoPath: "/tmp/myrepo", sha: "abc123", testExit: 0, diff: FIXTURE_DIFF, ts: NOW });
    expect(p.detail.code).toContain('throw new Error("NaN result");');
    expect(p.detail.code).toContain("const doubled = total * 2;");
    // lines from the smaller python hunk must NOT be present
    expect(p.detail.code).not.toContain("return os.getcwd()");
    // added-line markers stripped
    expect(p.detail.code).not.toContain("+");
    // context/removed lines excluded
    expect(p.detail.code).not.toContain("const total = a + b;");
  });

  it("detects lang from the winning hunk's file extension", () => {
    const p = buildCodeSignalPayload({ repoPath: "/tmp/myrepo", sha: "abc123", testExit: 0, diff: FIXTURE_DIFF, ts: NOW });
    expect(p.detail.lang).toBe("ts");
  });

  it("maps testExit 0 to outcome pass", () => {
    const p = buildCodeSignalPayload({ repoPath: "/tmp/myrepo", sha: "abc123", testExit: 0, diff: FIXTURE_DIFF, ts: NOW });
    expect(p.outcome).toBe("pass");
  });

  it("maps non-zero testExit to outcome fail", () => {
    const p = buildCodeSignalPayload({ repoPath: "/tmp/myrepo", sha: "abc123", testExit: 1, diff: FIXTURE_DIFF, ts: NOW });
    expect(p.outcome).toBe("fail");
  });

  it("defaults repo to the repoPath basename (never an absolute path)", () => {
    const p = buildCodeSignalPayload({ repoPath: "/srv/builds/projects/myrepo", sha: "abc123", testExit: 0, diff: FIXTURE_DIFF, ts: NOW });
    expect(p.repo).toBe("myrepo");
    expect(p.repo).not.toContain("/");
  });

  it("honors an explicit logical repo override", () => {
    const p = buildCodeSignalPayload({ repoPath: "/tmp/whatever", sha: "abc123", testExit: 0, diff: FIXTURE_DIFF, repo: "logical-name", ts: NOW });
    expect(p.repo).toBe("logical-name");
  });

  it("records the sha under detail.commit and NEVER sets detail.git_sha", () => {
    const p = buildCodeSignalPayload({ repoPath: "/tmp/myrepo", sha: "deadbeef", testExit: 0, diff: FIXTURE_DIFF, ts: NOW });
    expect(p.detail.commit).toBe("deadbeef");
    expect("git_sha" in p.detail).toBe(false);
  });

  it("emits a PATH-(b) payload shape with the expected fixed fields", () => {
    const p = buildCodeSignalPayload({ repoPath: "/tmp/myrepo", sha: "abc123", testExit: 0, diff: FIXTURE_DIFF, ts: NOW });
    expect(p.v).toBe(1);
    expect(p.kind).toBe("test");
    expect(p.producer).toBe("code-commit");
    expect(p.model).toBe("unknown");
    expect(p.step).toBeNull();
    expect(p.session).toBeNull();
    expect(p.ts).toBe("2026-06-09T12:00:00.000Z");
    expect(p.detail.test_exit).toBe(0);
  });

  it("derives task from args.task when provided, else from hunk funcname/file", () => {
    const explicit = buildCodeSignalPayload({ repoPath: "/tmp/myrepo", sha: "abc123", testExit: 0, diff: FIXTURE_DIFF, task: "harden add()", ts: NOW });
    expect(explicit.detail.task).toBe("harden add()");

    const derived = buildCodeSignalPayload({ repoPath: "/tmp/myrepo", sha: "abc123", testExit: 0, diff: FIXTURE_DIFF, ts: NOW });
    expect(derived.detail.task).toContain("src/calc.ts");
  });

  it("carries the model override through", () => {
    const p = buildCodeSignalPayload({ repoPath: "/tmp/myrepo", sha: "abc123", testExit: 0, diff: FIXTURE_DIFF, model: "qwen3-coder", ts: NOW });
    expect(p.model).toBe("qwen3-coder");
  });
});
