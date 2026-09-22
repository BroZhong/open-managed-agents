import { createPgPool, pgConfigFromEnv, EventPayloadCodec, OSSEventPayloadStore, migrateEventPayloads } from "@oma-server/store";
import { workspaceConfigFromEnv } from "./lib/workspace-config.js";

// pnpm --filter @oma-server/api exec tsx src/migrate-big-results.ts [--apply] [--session=sess_...]
const args = process.argv.slice(2);
if (args.some(a => a !== "--apply" && !/^--session=[A-Za-z0-9_-]+$/.test(a))) throw new Error("Usage: migrate-big-results.ts [--apply] [--session=sess_...]");
const pool = createPgPool(pgConfigFromEnv());
try {
  const codec = new EventPayloadCodec(new OSSEventPayloadStore(workspaceConfigFromEnv(process.env).oss));
  const stats = await migrateEventPayloads(pool, codec, { apply: args.includes("--apply"), sessionId: args.find(a => a.startsWith("--session="))?.slice(10) });
  console.log(JSON.stringify({ mode: args.includes("--apply") ? "apply" : "dry-run", ...stats }));
  if (stats.conflicts) process.exitCode = 2;
} finally { await pool.end(); }
