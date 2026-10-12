import { createPgPool, pgConfigFromEnv, migrateModelProviderCapabilities } from "@oma-server/store";

// pnpm --dir server --filter @oma-server/api exec tsx src/migrate-model-providers.ts [--apply]
const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--apply")) throw new Error("Usage: migrate-model-providers.ts [--apply]");
const pool = createPgPool(pgConfigFromEnv());
try {
  const stats = await migrateModelProviderCapabilities(pool, { apply: args.includes("--apply") });
  console.log(JSON.stringify({ mode: args.includes("--apply") ? "apply" : "dry-run", ...stats }));
  if (stats.conflicts) process.exitCode = 2;
} finally {
  await pool.end();
}
