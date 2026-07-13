import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createOpenApiDocument, serializeOpenApiDocument } from "./document.js";

const artifactPath = fileURLToPath(
  new URL("../../../../../docs/openapi.json", import.meta.url),
);
const serverUrl = process.env.OPENAPI_SERVER_URL ?? "http://localhost:3000";

async function generate(): Promise<void> {
  const expected = serializeOpenApiDocument(
    createOpenApiDocument({ serverUrl }),
  );

  if (process.argv.includes("--check")) {
    const committed = await readFile(artifactPath, "utf8").catch(() => "");
    if (committed !== expected) {
      console.error(
        "docs/openapi.json is stale. Run `pnpm openapi:generate` and commit the result.",
      );
      process.exitCode = 1;
    }
    return;
  }

  await writeFile(artifactPath, expected, "utf8");
  console.log(`Generated ${artifactPath}`);
}

await generate();
