/**
 * The projection: select, roll up, render, reconcile.
 *
 * Reads current content through the writer so reconcile can skip unchanged
 * files. Colliding spellings of one subject merge into a single page rather
 * than throwing (see slug.ts); only a slug that collides with a reserved
 * generated filename still propagates, because the alternative there is one
 * page silently overwriting the index or log.
 */
import type { FactStore } from "@ports/fact-store.js";
import type { WikiWriter } from "@ports/wiki-writer.js";
import type { ProjectionResult, WikiConfig } from "./types.js";
import { buildSlugGroups } from "./slug.js";
import { selectSubjects } from "./select.js";
import { rollupPages } from "./rollup.js";
import { renderAll } from "./render.js";
import { planReconcile } from "./reconcile.js";

export interface ProjectDeps {
  readonly facts: Pick<FactStore, "listSubjectStats" | "listForRecall">;
  readonly writer: WikiWriter;
}

export async function projectWiki(
  deps: ProjectDeps,
  tenantId: string,
  config: WikiConfig,
  today: string,
): Promise<ProjectionResult> {
  const stats = await deps.facts.listSubjectStats(tenantId);
  const selected = selectSubjects(stats, config);
  const groups = buildSlugGroups(selected.map((s) => s.subject));
  const pages = await rollupPages(deps, tenantId, selected, groups);
  const rendered = renderAll(pages, config, today);

  const existing = await deps.writer.list();
  const rendering = new Set(rendered.map((r) => r.relPath));
  const current = new Map<string, string>();
  for (const relPath of existing) {
    if (!rendering.has(relPath)) continue;
    const content = await deps.writer.read(relPath);
    if (content !== null) current.set(relPath, content);
  }

  const plan = planReconcile(rendered, existing, current);
  for (const file of plan.toWrite) await deps.writer.write(file.relPath, file.content);
  for (const relPath of plan.toRemove) await deps.writer.remove(relPath);

  const onDisk = (await deps.writer.list()).filter((p) => p !== "index.md" && p !== "log.md").length;
  return {
    written: plan.toWrite.length,
    unchanged: plan.unchanged,
    removed: plan.toRemove.length,
    qualifying: pages.length,
    onDisk,
    coverageDrift: pages.length - onDisk,
  };
}
