import { describe, it, expect } from "vitest";
import { slugify, buildSlugMap, SlugCollisionError } from "@core/wiki/slug.js";

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

describe("buildSlugMap", () => {
  it("maps every subject to its slug", () => {
    const map = buildSlugMap(["nlm-memory", "Whtnxt Agent"]);
    expect(map.get("nlm-memory")).toBe("nlm-memory");
    expect(map.get("Whtnxt Agent")).toBe("whtnxt-agent");
  });

  it("throws rather than letting one page overwrite another", () => {
    expect(() => buildSlugMap(["a b", "a/b"])).toThrow(SlugCollisionError);
  });

  it("names both colliding subjects in the error", () => {
    try {
      buildSlugMap(["a b", "a/b"]);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(SlugCollisionError);
      const err = e as SlugCollisionError;
      expect(err.slug).toBe("a-b");
      expect([...err.subjects].sort()).toEqual(["a b", "a/b"]);
    }
  });

  it("does not treat one subject appearing twice as a collision", () => {
    expect(() => buildSlugMap(["a b", "a b"])).not.toThrow();
  });

  it("throws when a subject slugs to the reserved index page", () => {
    expect(() => buildSlugMap(["index"])).toThrow(SlugCollisionError);
  });

  it("throws when a subject slugs to the reserved log page", () => {
    expect(() => buildSlugMap(["log"])).toThrow(SlugCollisionError);
  });

  it("throws on a reserved-name collision even when the subject isn't already lowercase", () => {
    expect(() => buildSlugMap(["Index"])).toThrow(SlugCollisionError);
    expect(() => buildSlugMap(["LOG"])).toThrow(SlugCollisionError);
  });

  it("names the reserved file in the error so the failure is diagnosable", () => {
    try {
      buildSlugMap(["log"]);
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
      buildSlugMap(["changelog", "logging", "blog-post", "index-fix"]),
    ).not.toThrow();
  });
});
