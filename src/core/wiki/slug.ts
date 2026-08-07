/**
 * Subject to filename. Subjects come from the classifier already lowercased
 * and trimmed by prompt contract, but that contract is not enforced at the
 * storage layer: a minority carry spaces, path separators, and colons. A raw
 * write of `scripts/release.sh` would create a subdirectory rather than a
 * page, so slugging is required, not cosmetic.
 *
 * Slugging is lossy, so two distinct subjects can land on one filename. That
 * would silently destroy a page, which is why buildSlugMap throws instead of
 * letting the second write win.
 */

const UNSAFE = /[^a-z0-9.-]+/g;
const RUNS = /-{2,}/g;
const EDGES = /^-+|-+$/g;

/**
 * Slugs `renderAll` always emits (`index.md`, `log.md`) regardless of the
 * corpus. A subject that slugs to one of these would silently overwrite the
 * generated file (or be overwritten by it), so buildSlugMap treats a match
 * here the same as a subject-vs-subject collision.
 */
export const RESERVED_SLUGS = ["index", "log"] as const;

export function slugify(subject: string): string {
  return subject
    .toLowerCase()
    .replace(UNSAFE, "-")
    .replace(RUNS, "-")
    .replace(EDGES, "");
}

export class SlugCollisionError extends Error {
  readonly slug: string;
  readonly subjects: ReadonlyArray<string>;

  constructor(slug: string, subjects: ReadonlyArray<string>) {
    super(
      `wiki slug collision: ${subjects.map((s) => JSON.stringify(s)).join(" and ")} ` +
        `both slug to ${JSON.stringify(slug)}`,
    );
    this.name = "SlugCollisionError";
    this.slug = slug;
    this.subjects = subjects;
  }
}

export function buildSlugMap(subjects: ReadonlyArray<string>): ReadonlyMap<string, string> {
  const bySlug = new Map<string, string>();
  const out = new Map<string, string>();
  for (const subject of subjects) {
    const slug = slugify(subject);
    if ((RESERVED_SLUGS as ReadonlyArray<string>).includes(slug)) {
      throw new SlugCollisionError(slug, [subject, `generated file ${slug}.md`]);
    }
    const existing = bySlug.get(slug);
    if (existing !== undefined && existing !== subject) {
      throw new SlugCollisionError(slug, [existing, subject]);
    }
    bySlug.set(slug, subject);
    out.set(subject, slug);
  }
  return out;
}
