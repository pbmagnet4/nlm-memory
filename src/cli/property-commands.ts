import type { Command } from "commander";
import { readFileSync } from "node:fs";
import type { Storage } from "@ports/storage.js";
export function registerPropertyCommands(program: Command, open: () => Promise<Storage>, tenantId: string): void {
  const command = program.command("properties").description("Manage canonical memory properties and attribution").option("--tenant <id>", "Tenant catalog to manage", tenantId);
  const run = async (operation: (storage: Storage, tenantId: string) => Promise<unknown>): Promise<void> => {
    const storage = await open();
    try { console.log(JSON.stringify(await operation(storage, command.opts<{ tenant: string }>().tenant), null, 2)); } finally { await storage.close(); }
  };
  command.command("list").action(() => run((s, tenantId) => s.properties.list(tenantId)));
  command.command("import").argument("<file>", "JSON array of slug, label, aliases and repositories")
    .action((file: string) => run(async (s, tenantId) => { await s.properties.import(tenantId, JSON.parse(readFileSync(file, "utf8"))); return s.properties.list(tenantId); }));
  command.command("correct").argument("<factId>").argument("[property]", "Canonical property slug").option("--clear", "Reject property attribution")
    .action((factId: string, property: string | undefined, options: { clear?: boolean }) => run(async (s, tenantId) => {
      if ((!property && !options.clear) || (property && options.clear)) throw new Error("Provide a property slug or --clear");
      await s.properties.correctFact(tenantId, factId, options.clear ? null : property!); return s.facts.getById(tenantId, factId);
    }));
  command.command("associate-session").argument("<sessionId>").argument("[properties...]", "Canonical property slugs; empty clears explicit associations")
    .action((sessionId: string, slugs: string[]) => run(async (s, tenantId) => { await s.properties.associateSession(tenantId, sessionId, slugs); return { sessionId, properties: slugs }; }));
  command.command("backfill").option("--apply", "Apply the attribution-only backfill; default is dry-run", false)
    .action((options: { apply: boolean }) => run((s, tenantId) => s.properties.backfill(tenantId, options.apply)));
  command.command("pending").description("List corrections whose assertion no longer matches a stored fact")
    .action(() => run((s, tenantId) => s.properties.pendingCorrections(tenantId)));
}
