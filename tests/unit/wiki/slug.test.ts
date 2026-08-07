import { describe, it, expect } from "vitest";
import { slugify, buildSlugGroups, SlugCollisionError } from "@core/wiki/slug.js";

describe("slugify", () => {
  it("passes through an already-safe subject", () => {
    expect(slugify("nlm-memory")).toBe("nlm-memory");
  });

  it("replaces a path separator so no subdirectory is created", () => {
    expect(slugify("scripts/release.sh")).toBe("scripts-release.sh");
  });

  it("replaces a colon", () => {
    expect(slugify("qwen3.5:4b")).toBe("qwen3.5-4b");
  });

  it("lowercases and replaces spaces", () => {
    expect(slugify("Whtnxt Agent")).toBe("whtnxt-agent");
  });

  it("collapses runs of separators and trims them from the ends", () => {
    expect(slugify("  a // b  ")).toBe("a-b");
  });

  it("collapses adjacent hyphens from replacement and literal hyphens", () => {
    expect(slugify("foo-/bar")).toBe("foo-bar");
  });

  it("preserves dots and existing hyphens", () => {
    expect(slugify("surface_gemini.py")).toBe("surface-gemini.py");
  });
});

describe("buildSlugGroups", () => {
  it("groups two colliding subjects together, sorted, with both members present", () => {
    // Supplied out of order (colon spelling first) so a sort-free
    // implementation would fail this deterministically.
    const groups = buildSlugGroups(["qwen3.5:4b", "qwen3.5-4b"]);
    expect(groups.get("qwen3.5-4b")).toEqual(["qwen3.5-4b", "qwen3.5:4b"]);
  });

  it("does not treat one subject appearing twice as two members", () => {
    const groups = buildSlugGroups(["a b", "a b"]);
    expect(groups.get("a-b")).toEqual(["a b"]);
  });

  it("gives non-colliding subjects their own single-member group", () => {
    const groups = buildSlugGroups(["nlm-memory", "Whtnxt Agent"]);
    expect(groups.get("nlm-memory")).toEqual(["nlm-memory"]);
    expect(groups.get("whtnxt-agent")).toEqual(["Whtnxt Agent"]);
  });

  it("throws when a subject slugs to the reserved index page", () => {
    expect(() => buildSlugGroups(["index"])).toThrow(SlugCollisionError);
  });

  it("throws when a subject slugs to the reserved log page", () => {
    expect(() => buildSlugGroups(["log"])).toThrow(SlugCollisionError);
  });

  it("throws on a reserved-name collision even when the subject isn't already lowercase", () => {
    expect(() => buildSlugGroups(["Index"])).toThrow(SlugCollisionError);
    expect(() => buildSlugGroups(["LOG"])).toThrow(SlugCollisionError);
  });

  it("names the reserved file in the error so the failure is diagnosable", () => {
    try {
      buildSlugGroups(["log"]);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(SlugCollisionError);
      const err = e as SlugCollisionError;
      expect(err.message).toMatch(/log\.md/);
      expect(err.subjects.some((s) => s.includes("log.md"))).toBe(true);
    }
  });

  it("does not reject ordinary near-miss subjects that merely resemble reserved names", () => {
    expect(() =>
      buildSlugGroups(["changelog", "logging", "blog-post", "index-fix"]),
    ).not.toThrow();
  });
});
