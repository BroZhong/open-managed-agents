import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const HTTP_METHODS = new Set([
  "delete",
  "get",
  "head",
  "options",
  "patch",
  "post",
  "put",
  "trace",
]);
const REQUIRED_SENTINELS = ["GET\0/health", "GET\0/openapi.json"];

function operationKey(operation) {
  return `${operation.method.toUpperCase()}\0${operation.path}`;
}

function displayOperation(operation) {
  return `${operation.method.toUpperCase()} ${operation.path}`;
}

function normalizeOperation(operation) {
  if (
    !operation ||
    typeof operation.method !== "string" ||
    typeof operation.path !== "string" ||
    !operation.path.startsWith("/")
  ) {
    throw new Error("Every endpoint must have a string method and absolute path");
  }
  return { ...operation, method: operation.method.toUpperCase() };
}

function assertUniqueOperations(operations, label) {
  const seen = new Set();
  for (const operation of operations) {
    const key = operationKey(operation);
    if (seen.has(key)) {
      throw new Error(`Duplicate ${label} operation: ${displayOperation(operation)}`);
    }
    seen.add(key);
  }
  return seen;
}

export function operationsFromOpenApi(document) {
  if (!document || typeof document.paths !== "object" || !document.paths) {
    throw new Error("OpenAPI document must contain a paths object");
  }

  const operations = [];
  for (const [path, pathItem] of Object.entries(document.paths)) {
    if (!pathItem || typeof pathItem !== "object") continue;
    for (const method of Object.keys(pathItem)) {
      if (HTTP_METHODS.has(method.toLowerCase())) {
        operations.push(normalizeOperation({ method, path }));
      }
    }
  }
  return operations.sort((left, right) =>
    displayOperation(left).localeCompare(displayOperation(right)),
  );
}

export function schemaNamesFromOpenApi(document) {
  const schemas = document?.components?.schemas;
  if (schemas === undefined) return [];
  if (!schemas || typeof schemas !== "object" || Array.isArray(schemas)) {
    throw new Error("OpenAPI components.schemas must be an object");
  }
  return Object.keys(schemas).sort((left, right) => left.localeCompare(right));
}

function validateInventories(desiredOperations, remoteEndpoints) {
  const desired = desiredOperations.map(normalizeOperation);
  const remote = remoteEndpoints.map((endpoint) => {
    if (!Number.isSafeInteger(endpoint?.id) || endpoint.id <= 0) {
      throw new Error("Every remote endpoint must have a positive integer id");
    }
    return normalizeOperation(endpoint);
  });
  if (desired.length === 0) {
    throw new Error("Refusing to reconcile an empty OpenAPI operation set");
  }

  const desiredKeys = assertUniqueOperations(desired, "desired");
  const remoteKeys = assertUniqueOperations(remote, "remote");
  for (const sentinel of REQUIRED_SENTINELS) {
    if (!desiredKeys.has(sentinel)) {
      const [method, path] = sentinel.split("\0");
      throw new Error(`Missing repository sentinel operation: ${method} ${path}`);
    }
  }
  return { desired, desiredKeys, remote, remoteKeys };
}

export function assertSafeTargetInventory(desiredOperations, remoteEndpoints) {
  const { remote, remoteKeys } = validateInventories(
    desiredOperations,
    remoteEndpoints,
  );
  if (
    remote.length > 0 &&
    REQUIRED_SENTINELS.some((sentinel) => !remoteKeys.has(sentinel))
  ) {
    throw new Error(
      "Target is not an empty or previously managed project; refusing to import",
    );
  }
}

function unmatchedRemoteEndpoints(desiredKeys, remote) {
  return remote
    .filter((endpoint) => !desiredKeys.has(operationKey(endpoint)))
    .sort((left, right) =>
      displayOperation(left).localeCompare(displayOperation(right)),
    );
}

function assertDeletionLimit(deleteEndpoints, maxDeletions) {
  if (!Number.isSafeInteger(maxDeletions) || maxDeletions < 0) {
    throw new Error("Deletion safety limit must be a non-negative integer");
  }
  if (deleteEndpoints.length > maxDeletions) {
    throw new Error(
      `Deletion plan (${deleteEndpoints.length}) exceeds the safety limit (${maxDeletions}): ${deleteEndpoints
        .slice(0, 20)
        .map(displayOperation)
        .join(", ")}`,
    );
  }
}

export function createPreflightDeletionPlan(
  desiredOperations,
  remoteEndpoints,
  maxDeletions,
) {
  const { desiredKeys, remote } = validateInventories(
    desiredOperations,
    remoteEndpoints,
  );
  const deleteEndpoints = unmatchedRemoteEndpoints(desiredKeys, remote);
  assertDeletionLimit(deleteEndpoints, maxDeletions);
  return { deleteEndpoints };
}

function validateSchemaInventories(desiredSchemaNames, remoteSchemas) {
  const desired = desiredSchemaNames.map((name) => {
    if (typeof name !== "string" || name.trim() === "") {
      throw new Error("Every desired schema must have a non-empty name");
    }
    return name;
  });
  const remote = remoteSchemas.map((schema) => {
    if (!Number.isSafeInteger(schema?.id) || schema.id <= 0) {
      throw new Error("Every remote schema must have a positive integer id");
    }
    if (typeof schema.name !== "string" || schema.name.trim() === "") {
      throw new Error("Every remote schema must have a non-empty name");
    }
    return schema;
  });
  const desiredNames = new Set(desired);
  const remoteNames = new Set();
  for (const schema of remote) {
    if (remoteNames.has(schema.name)) {
      throw new Error(`Duplicate remote schema: ${schema.name}`);
    }
    remoteNames.add(schema.name);
  }
  return { desired, desiredNames, remote, remoteNames };
}

export function createSchemaDeletionPlan(
  desiredSchemaNames,
  remoteSchemas,
  maxDeletions,
  { requireComplete = false } = {},
) {
  if (!Number.isSafeInteger(maxDeletions) || maxDeletions < 0) {
    throw new Error("Schema deletion safety limit must be a non-negative integer");
  }
  const { desired, desiredNames, remote, remoteNames } =
    validateSchemaInventories(desiredSchemaNames, remoteSchemas);
  if (requireComplete) {
    const missing = desired.filter((name) => !remoteNames.has(name));
    if (missing.length > 0) {
      throw new Error(
        `Remote project is missing desired schemas after import: ${missing.join(", ")}`,
      );
    }
  }
  const deleteSchemas = remote
    .filter((schema) => !desiredNames.has(schema.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (deleteSchemas.length > maxDeletions) {
    throw new Error(
      `Schema deletion plan (${deleteSchemas.length}) exceeds the safety limit (${maxDeletions}): ${deleteSchemas
        .slice(0, 20)
        .map((schema) => schema.name)
        .join(", ")}`,
    );
  }
  return { deleteSchemas };
}

export function createReconciliationPlan(
  desiredOperations,
  remoteEndpoints,
  maxDeletions,
) {
  const { desired, desiredKeys, remote, remoteKeys } = validateInventories(
    desiredOperations,
    remoteEndpoints,
  );

  const missing = desired.filter(
    (operation) => !remoteKeys.has(operationKey(operation)),
  );
  if (missing.length > 0) {
    throw new Error(
      `Remote project is missing desired operations after import: ${missing
        .map(displayOperation)
        .join(", ")}`,
    );
  }

  const deleteEndpoints = unmatchedRemoteEndpoints(desiredKeys, remote);
  assertDeletionLimit(deleteEndpoints, maxDeletions);

  return { deleteEndpoints };
}

function sanitize(value, token) {
  const text = String(value ?? "");
  return (token ? text.split(token).join("***") : text).trim();
}

function runApifox(args, token) {
  try {
    return execFileSync(
      "npx",
      ["--yes", "apifox-cli@2.2.7", ...args, "--access-token", token],
      {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (error) {
    const stderr = sanitize(error?.stderr, token);
    const stdout = sanitize(error?.stdout, token);
    throw new Error(
      `Apifox CLI command failed${stderr ? `: ${stderr}` : stdout ? `: ${stdout}` : ""}`,
    );
  }
}

function parseListResponse(raw, projectId, page) {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error(`Apifox endpoint list page ${page} did not return JSON`);
  }
  if (
    payload?.success !== true ||
    !Array.isArray(payload.data) ||
    !payload.meta ||
    String(payload.context?.projectId) !== String(projectId)
  ) {
    throw new Error(`Apifox endpoint list page ${page} has an invalid envelope`);
  }
  const nextPage = payload.meta.nextPage;
  if (nextPage !== null && !Number.isSafeInteger(nextPage)) {
    throw new Error(`Apifox endpoint list page ${page} has invalid pagination`);
  }
  return { endpoints: payload.data, nextPage };
}

function listEndpoints(projectId, token) {
  const endpoints = [];
  const visitedPages = new Set();
  let page = 1;
  while (page !== null) {
    if (visitedPages.has(page) || visitedPages.size >= 1_000) {
      throw new Error("Apifox endpoint pagination did not terminate safely");
    }
    visitedPages.add(page);
    const raw = runApifox(
      [
        "endpoint",
        "list",
        "--project",
        projectId,
        "--page",
        String(page),
        "--page-size",
        // Keep each CLI JSON envelope comfortably below constrained child
        // process output buffers while still following meta.nextPage exactly.
        "20",
      ],
      token,
    );
    const result = parseListResponse(raw, projectId, page);
    endpoints.push(...result.endpoints);
    page = result.nextPage;
  }
  return endpoints;
}

function listSchemas(projectId, token) {
  const raw = runApifox(["schema", "list", "--project", projectId], token);
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error("Apifox schema list did not return JSON");
  }
  if (
    payload?.success !== true ||
    !Array.isArray(payload.data) ||
    String(payload.context?.projectId) !== String(projectId)
  ) {
    throw new Error("Apifox schema list has an invalid envelope");
  }
  return payload.data;
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid argument near ${flag ?? "end of command"}`);
    }
    values.set(flag.slice(2), value);
  }
  return values;
}

function main() {
  const args = parseArguments(process.argv.slice(2));
  const specPath = args.get("spec");
  const projectId = args.get("project");
  const mode = args.get("mode") ?? "reconcile";
  const token = process.env.APIFOX_ACCESS_TOKEN;
  const maxDeletions = Number(
    args.get("max-deletions") ||
      process.env.APIFOX_MAX_ENDPOINT_DELETIONS ||
      "10",
  );
  const maxSchemaDeletions = Number(
    args.get("max-schema-deletions") ||
      process.env.APIFOX_MAX_SCHEMA_DELETIONS ||
      "10",
  );
  if (!specPath || !projectId || !token) {
    throw new Error(
      "Usage: APIFOX_ACCESS_TOKEN=... node apifox-reconcile.mjs --spec openapi.json --project ID [--max-deletions N] [--max-schema-deletions N]",
    );
  }

  const document = JSON.parse(readFileSync(resolve(specPath), "utf8"));
  const desired = operationsFromOpenApi(document);
  const desiredSchemas = schemaNamesFromOpenApi(document);
  const before = listEndpoints(projectId, token);
  const schemasBefore = listSchemas(projectId, token);
  if (mode === "preflight") {
    assertSafeTargetInventory(desired, before);
    const plan = createPreflightDeletionPlan(desired, before, maxDeletions);
    const schemaPlan = createSchemaDeletionPlan(
      desiredSchemas,
      schemasBefore,
      maxSchemaDeletions,
    );
    console.log(
      `Verified safe Apifox target inventory before import (${before.length} existing endpoints, ${schemasBefore.length} schemas; ${plan.deleteEndpoints.length} endpoint and ${schemaPlan.deleteSchemas.length} schema deletions planned).`,
    );
    return;
  }
  if (mode !== "reconcile") {
    throw new Error(`Unsupported reconciliation mode: ${mode}`);
  }
  const plan = createReconciliationPlan(desired, before, maxDeletions);
  console.log(
    `Apifox import contains all ${desired.length} desired HTTP operations.`,
  );

  for (const endpoint of plan.deleteEndpoints) {
    console.log(`Deleting unmatched endpoint: ${displayOperation(endpoint)}`);
    runApifox(
      ["endpoint", "delete", String(endpoint.id), "--project", projectId],
      token,
    );
  }

  const schemaPlan = createSchemaDeletionPlan(
    desiredSchemas,
    schemasBefore,
    maxSchemaDeletions,
    { requireComplete: true },
  );
  for (const schema of schemaPlan.deleteSchemas) {
    console.log(`Deleting unmatched schema: ${schema.name}`);
    runApifox(
      ["schema", "delete", String(schema.id), "--project", projectId],
      token,
    );
  }

  const after = listEndpoints(projectId, token);
  const schemasAfter = listSchemas(projectId, token);
  const verification = createReconciliationPlan(desired, after, 0);
  if (verification.deleteEndpoints.length !== 0) {
    throw new Error("Apifox endpoint reconciliation did not converge");
  }
  const schemaVerification = createSchemaDeletionPlan(
    desiredSchemas,
    schemasAfter,
    0,
    { requireComplete: true },
  );
  if (schemaVerification.deleteSchemas.length !== 0) {
    throw new Error("Apifox schema reconciliation did not converge");
  }
  console.log(
    `Verified exact Apifox inventory: ${desired.length} HTTP operations and ${desiredSchemas.length} schemas.`,
  );
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    main();
  } catch (error) {
    console.error(`::error::${sanitize(error?.message, process.env.APIFOX_ACCESS_TOKEN ?? "")}`);
    process.exitCode = 1;
  }
}
