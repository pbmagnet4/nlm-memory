/**
 * Diff the rendered set against what is on disk.
 *
 * Skipping byte-identical files is what makes a 6-hourly job free: a run with
 * no corpus change writes nothing and Obsidian never re-indexes. Removing
 * files with no rendered counterpart is what keeps the tree a projection
 * rather than an append-only pile.
 */
import type { RenderedPage } from "./types.js";

export interface ReconcilePlan {
  readonly toWrite: ReadonlyArray<RenderedPage>;
  readonly toRemove: ReadonlyArray<string>;
  readonly unchanged: number;
}

export function planReconcile(
  rendered: ReadonlyArray<RenderedPage>,
  existing: ReadonlyArray<string>,
  current: ReadonlyMap<string, string>,
): ReconcilePlan {
  const toWrite: RenderedPage[] = [];
  let unchanged = 0;
  for (const file of rendered) {
    if (current.get(file.relPath) === file.content) unchanged += 1;
    else toWrite.push(file);
  }
  const keep = new Set(rendered.map((f) => f.relPath));
  const toRemove = existing.filter((p) => !keep.has(p));
  return { toWrite, toRemove, unchanged };
}
