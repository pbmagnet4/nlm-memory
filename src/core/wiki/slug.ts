/**
 * Subject to filename. Subjects come from the classifier already lowercased
 * and trimmed by prompt contract, but that contract is not enforced at the
 * storage layer: a minority carry spaces, path separators, and colons. A raw
 * write of `scripts/release.sh` would create a subdirectory rather than a
 * page, so slugging is required, not cosmetic.
 *
 * Slugging is lossy, so two distinct subjects can land on one filename.
 * Empirically every such collision on the real corpus is one concept spelled
 * two ways, so buildSlugGroups merges them into a single page rather than
 * throwing; rollup.ts picks a canonical spelling and lists the rest as
 * aliases. A slug that matches a reserved filename is different in kind (it
 * would collide with a generated file, not another subject) and still
 * throws.
 */

const UNSAFE = /[^a-z0-9.-]+/g;
const RUNS = /-{2,}/g;
const EDGES = /^-+|-+$/g;

/**
 * Slugs `renderAll` always emits (`index.md`, `log.md`) regardless of the
 * corpus. A subject that slugs to one of these would silently overwrite the
 * generated file (or be overwritten by it), so buildSlugGroups still throws
 * on a match here rather than merging a subject's facts into the index.
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

/**
 * Group selected subjects by slug. A slug with more than one member is a
 * merge candidate for rollup.ts, not an error: only a match against a
 * reserved filename still throws. Members of each group are deduplicated and
 * sorted with localeCompare so the group's contents are deterministic
 * regardless of input order.
 */
export function buildSlugGroups(
  subjects: ReadonlyArray<string>,
): ReadonlyMap<string, ReadonlyArray<string>> {
  const bySlug = new Map<string, Set<string>>();
  for (const subject of subjects) {
    const slug = slugify(subject);
    if ((RESERVED_SLUGS as ReadonlyArray<string>).includes(slug)) {
      throw new SlugCollisionError(slug, [subject, `generated file ${slug}.md`]);
    }
    let members = bySlug.get(slug);
    if (!members) {
      members = new Set<string>();
      bySlug.set(slug, members);
    }
    members.add(subject);
  }
  const out = new Map<string, ReadonlyArray<string>>();
  for (const slug of [...bySlug.keys()].sort((a, b) => a.localeCompare(b))) {
    out.set(
      slug,
      [...bySlug.get(slug)!].sort((a, b) => a.localeCompare(b)),
    );
  }
  return out;
}
