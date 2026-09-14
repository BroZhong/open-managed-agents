import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { operationsFromOpenApi } from "./apifox-reconcile.mjs";

const APIFOX_API_VERSION = "2024-03-28";
const APIFOX_API_ORIGIN = "https://api.apifox.com";

function nonNegativeCounter(counters, name) {
  const value = counters?.[name];
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Apifox import returned an invalid ${name} counter`);
  }
  return value;
}

function countSchemas(document) {
  const schemas = document?.components?.schemas;
  if (schemas === undefined) return 0;
  if (!schemas || typeof schemas !== "object" || Array.isArray(schemas)) {
    throw new Error("OpenAPI components.schemas must be an object");
  }
  return Object.keys(schemas).length;
}

export function createImportPayload(document) {
  return {
    // The public API accepts JSON/YAML as a string. Keeping the contract in a
    // single string avoids relying on undocumented object-input behavior.
    input: JSON.stringify(document),
    options: {
      endpointOverwriteBehavior: "OVERWRITE_EXISTING",
      schemaOverwriteBehavior: "OVERWRITE_EXISTING",
      updateFolderOfChangedEndpoint: true,
      prependBasePath: false,
      deleteUnmatchedResources: true,
    },
  };
}

export function validateImportResponse(document, response) {
  const counters = response?.data?.counters;
  if (!counters || typeof counters !== "object" || Array.isArray(counters)) {
    throw new Error("Apifox import returned an invalid response envelope");
  }
  const errors = response.data.errors;
  if (errors !== undefined && !Array.isArray(errors)) {
    throw new Error("Apifox import returned an invalid errors collection");
  }
  if (errors?.length > 0) {
    throw new Error(
      `Apifox import reported errors: ${errors
        .slice(0, 3)
        .map((error) => String(error?.code ?? "unknown"))
        .join(", ")}`,
    );
  }

  const expectedEndpoints = operationsFromOpenApi(document).length;
  const expectedSchemas = countSchemas(document);
  const endpointCreated = nonNegativeCounter(counters, "endpointCreated");
  const endpointUpdated = nonNegativeCounter(counters, "endpointUpdated");
  const endpointFailed = nonNegativeCounter(counters, "endpointFailed");
  const endpointIgnored = nonNegativeCounter(counters, "endpointIgnored");
  const schemaCreated = nonNegativeCounter(counters, "schemaCreated");
  const schemaUpdated = nonNegativeCounter(counters, "schemaUpdated");
  const schemaFailed = nonNegativeCounter(counters, "schemaFailed");
  const schemaIgnored = nonNegativeCounter(counters, "schemaIgnored");
  const endpointFolderFailed = nonNegativeCounter(
    counters,
    "endpointFolderFailed",
  );
  const schemaFolderFailed = nonNegativeCounter(counters, "schemaFolderFailed");

  if (endpointFailed !== 0 || endpointIgnored !== 0) {
    throw new Error(
      `Apifox did not overwrite every endpoint (failed=${endpointFailed}, ignored=${endpointIgnored})`,
    );
  }
  if (schemaFailed !== 0 || schemaIgnored !== 0) {
    throw new Error(
      `Apifox did not overwrite every schema (failed=${schemaFailed}, ignored=${schemaIgnored})`,
    );
  }
  if (endpointFolderFailed !== 0 || schemaFolderFailed !== 0) {
    throw new Error(
      `Apifox folder synchronization failed (endpoint=${endpointFolderFailed}, schema=${schemaFolderFailed})`,
    );
  }
  if (endpointCreated + endpointUpdated !== expectedEndpoints) {
    throw new Error(
      `Apifox processed ${endpointCreated + endpointUpdated} endpoints instead of ${expectedEndpoints}`,
    );
  }
  if (schemaCreated + schemaUpdated !== expectedSchemas) {
    throw new Error(
      `Apifox processed ${schemaCreated + schemaUpdated} schemas instead of ${expectedSchemas}`,
    );
  }

  return {
    endpointCreated,
    endpointUpdated,
    schemaCreated,
    schemaUpdated,
    expectedEndpoints,
    expectedSchemas,
  };
}

function sanitize(value, token) {
  const text = String(value ?? "");
  return (token ? text.split(token).join("***") : text).trim();
}

function safeErrorDetail(responseText, token) {
  let payload;
  try {
    payload = JSON.parse(responseText);
  } catch {
    return "";
  }
  const candidates = [
    payload?.message,
    payload?.error?.message,
    ...(Array.isArray(payload?.data?.errors)
      ? payload.data.errors.slice(0, 3).map((error) => error?.message)
      : []),
  ].filter((message) => typeof message === "string" && message.trim() !== "");
  return candidates.length > 0
    ? `: ${sanitize(candidates.join("; ").slice(0, 1_000), token)}`
    : "";
}

async function importOpenApi(document, projectId, token) {
  if (!/^[1-9][0-9]*$/.test(projectId)) {
    throw new Error("APIFOX_PROJECT_ID must be a positive integer");
  }

  const response = await fetch(
    `${APIFOX_API_ORIGIN}/v1/projects/${projectId}/import-openapi`,
    {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-Apifox-Api-Version": APIFOX_API_VERSION,
      },
      body: JSON.stringify(createImportPayload(document)),
    },
  );
  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(
      `Apifox OpenAPI import failed with HTTP ${response.status}${safeErrorDetail(responseText, token)}`,
    );
  }

  let payload;
  try {
    payload = JSON.parse(responseText);
  } catch {
    throw new Error("Apifox OpenAPI import did not return JSON");
  }
  return validateImportResponse(document, payload);
}

function parseArguments(argv) {
  if (argv.length !== 2 || argv[0] !== "--spec" || !argv[1]) {
    throw new Error("Usage: node apifox-import.mjs --spec openapi.json");
  }
  return argv[1];
}

async function main() {
  const specPath = parseArguments(process.argv.slice(2));
  const projectId = process.env.APIFOX_PROJECT_ID;
  const token = process.env.APIFOX_ACCESS_TOKEN;
  if (!projectId || !token) {
    throw new Error("APIFOX_PROJECT_ID and APIFOX_ACCESS_TOKEN are required");
  }
  const document = JSON.parse(readFileSync(resolve(specPath), "utf8"));
  const result = await importOpenApi(document, projectId, token);
  console.log(
    `Apifox overwrote the generated contract: ${result.expectedEndpoints} endpoints (${result.endpointCreated} created, ${result.endpointUpdated} updated), ${result.expectedSchemas} schemas (${result.schemaCreated} created, ${result.schemaUpdated} updated).`,
  );
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    await main();
  } catch (error) {
    console.error(
      `::error::${sanitize(error instanceof Error ? error.message : error, process.env.APIFOX_ACCESS_TOKEN ?? "")}`,
    );
    process.exitCode = 1;
  }
}
