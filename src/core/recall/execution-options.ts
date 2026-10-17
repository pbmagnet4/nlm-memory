export interface RecallExecutionOptions {
  readonly workstreamIds?: readonly string[];
}

export async function executionWorkstreamIds(
  tenantId: string, selector: string | undefined, options: RecallExecutionOptions,
  resolver?: (tenantId: string, idOrLabel: string) => Promise<readonly string[]>,
): Promise<readonly string[] | undefined> {
  if (selector === undefined) return options.workstreamIds;
  const resolved = resolver ? await resolver(tenantId, selector) : [];
  if (options.workstreamIds !== undefined) {
    const requested = new Set(options.workstreamIds);
    if (resolved.length !== requested.size || resolved.some((id) => !requested.has(id))) {
      throw new Error("Inconsistent recall scope constraints");
    }
  }
  return resolved;
}
