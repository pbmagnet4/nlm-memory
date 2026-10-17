import { parentPort, workerData } from "node:worker_threads";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { readSemanticSessions } from "./sqlite-semantic-sessions.js";
import { readSemanticFacts } from "./sqlite-semantic-facts.js";
import type { SemanticRead } from "./sqlite-semantic-reader.js";

const db = new Database(workerData.dbPath, { readonly: true, fileMustExist: true });
sqliteVec.load(db);
db.pragma("query_only = ON");
parentPort!.on("message", (request: SemanticRead) => {
  const start = performance.now();
  try {
    const rows = request.lane === "sessions"
      ? readSemanticSessions(db, request.tenantId, request.queryVector, request.limit, request.options)
      : readSemanticFacts(db, request.tenantId, request.queryVector, request.limit, request.options);
    parentPort!.postMessage({ rows, sqlMs: performance.now() - start });
  } catch {
    parentPort!.postMessage({ error: "semantic read failed", sqlMs: performance.now() - start });
  }
});
