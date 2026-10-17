import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
const [repo, dbPath, mode, layout = "src"] = process.argv.slice(2);
const load = (path) => import(pathToFileURL(join(repo, layout, layout === "dist" ? path.replace(/\.ts$/, ".js") : path)).href);
const { runMcpStdio } = await load("cli/nlm.ts");
const { SqliteStorage } = await load("core/storage/sqlite-storage.ts");
const { RecallService } = await load("core/recall/recall-service.ts");
const { FactRecallService } = await load("core/recall-facts/fact-recall-service.ts");
const { createMcpServer } = await load("mcp/server.ts");
const storage = SqliteStorage.create({ dbPath, migrationsDir: join(repo, "migrations") });
await storage.init();
let reads = 0; let closes = 0;
const reader = storage.sessions.semanticReader;
const read = reader.read.bind(reader);
reader.read = (...args) => { reads++; return read(...args); };
const close = storage.close.bind(storage);
storage.close = async () => { closes++; await close(); };
const llm = { embed: async () => ({ vector: new Float32Array(768), model: "fixture" }) };
const transport = new StdioServerTransport();
if (mode === "startup-connect") transport.start = async () => { throw new Error("fixture startup connect"); };
const prior = Object.fromEntries(["SIGINT", "SIGTERM"].map((name) => [name, process.listenerCount(name)]));
const inputEvents = ["end", "close", "error", "data"];
const inputBefore = inputEvents.map((name) => process.stdin.listenerCount(name));
let failure;
try {
  await runMcpStdio(storage, () => {
    if (mode === "startup-create") throw new Error("fixture startup create");
    const server = createMcpServer({ store: storage.sessions, factStore: storage.facts,
      recall: new RecallService({ store: storage.sessions, llm }),
      factRecall: new FactRecallService({ factStore: storage.facts, llm }) }, "team_local");
    server.registerTool("fixture_close", { inputSchema: {} }, async () => {
      setImmediate(() => {
        if (mode === "server") void server.close();
        else if (mode === "transport") void transport.close();
        else { process.emit("SIGTERM"); process.emit("SIGINT"); void server.close(); void transport.close(); }
      });
      return { content: [{ type: "text", text: "closing" }] };
    });
    return server;
  }, transport);
} catch (error) { failure = error.message; }
process.stdout.write(JSON.stringify({ fixture: true, reads, closes, failure,
  signalListeners: Object.fromEntries(Object.keys(prior).map((name) => [name, process.listenerCount(name) - prior[name]])),
  inputListeners: inputEvents.map((name, i) => process.stdin.listenerCount(name) - inputBefore[i]) }) + "\n");
