import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const HTTP_METHODS = new Set([
  "get", "put", "post", "delete", "options", "head", "patch", "trace",
]);
const SCHEMA_MAPS = new Set([
  "properties", "patternProperties", "$defs", "definitions", "dependentSchemas",
]);
const SCHEMA_CHILDREN = new Set([
  "items", "additionalProperties", "unevaluatedProperties", "unevaluatedItems",
  "contains", "propertyNames", "not", "if", "then", "else", "contentSchema",
]);
const SCHEMA_ARRAYS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const OAS_MAPS = {
  responses: "response", headers: "parameter", requestBodies: "requestBody",
  content: "mediaType", examples: "example", securitySchemes: "securityScheme",
};
const has = (object, key) => Object.hasOwn(object, key);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isDecoration = (key) => key.startsWith("x-apifox") || key === "x-run-in-apifox";
const emptyObject = (value) => isObject(value) && Object.keys(value).length === 0;

// Literal JSON (examples, defaults, enum values) must not lose fields merely
// because a user object happens to use a name such as properties or x-apifox.
function literal(value) {
  if (Array.isArray(value)) return value.map(literal);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, literal(value[key])]));
}

function unordered(values) {
  return values.map(literal).sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right)),
  );
}

function uniqueExamples(values) {
  return [...new Map(unordered(values).map((value) => [JSON.stringify(value), value])).values()];
}

function normalizeSchema(schema) {
  if (schema === true) return {};
  if (!isObject(schema)) return schema;
  const result = {};
  for (const [key, value] of Object.entries(schema)) {
    if (isDecoration(key) || key === "example" || key === "examples") continue;
    if ((key === "description" || key === "title") && value === "") continue;
    if (["deprecated", "readOnly", "writeOnly", "uniqueItems", "nullable"].includes(key) && value === false) continue;
    if (SCHEMA_MAPS.has(key) && isObject(value)) {
      if (Object.keys(value).length > 0) {
        result[key] = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, normalizeSchema(child)]));
      }
    } else if (SCHEMA_CHILDREN.has(key)) {
      const child = normalizeSchema(value);
      if (!(key === "additionalProperties" && emptyObject(child))) result[key] = child;
    } else if (SCHEMA_ARRAYS.has(key) && Array.isArray(value)) {
      const children = value.map(normalizeSchema);
      result[key] = key === "prefixItems" ? children : unordered(children);
    } else if ((key === "required" || key === "enum") && Array.isArray(value)) {
      if (key !== "required" || value.length > 0) result[key] = unordered(value);
    } else {
      result[key] = literal(value);
    }
  }
  if (typeof schema.type === "string" || Array.isArray(schema.type)) {
    const types = typeof schema.type === "string" ? [schema.type] : [...schema.type];
    if (schema.nullable === true) types.push("null");
    result.type = [...new Set(types)].sort();
    delete result.nullable;
  }
  const examples = [];
  if (has(schema, "example")) examples.push(schema.example);
  if (Array.isArray(schema.examples)) examples.push(...schema.examples);
  else if (has(schema, "examples")) result.examples = literal(schema.examples);
  // The exporter can retain example and also emit the same value in examples.
  if (examples.length > 0) result.examples = uniqueExamples(examples);
  return literal(result);
}

function resolveReference(document, value, seen = new Set()) {
  if (!isObject(value) || typeof value.$ref !== "string" || !value.$ref.startsWith("#/")) return value;
  if (seen.has(value.$ref)) throw new Error("Cannot verify a cyclic non-schema OpenAPI reference");
  const next = new Set(seen).add(value.$ref);
  let target = document;
  for (const segment of value.$ref.slice(2).split("/")) {
    const key = segment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!isObject(target) || !has(target, key)) throw new Error("Cannot verify an unresolved OpenAPI reference");
    target = target[key];
  }
  if (!isObject(target)) throw new Error("Invalid non-schema OpenAPI reference target");
  const { $ref, ...siblings } = value;
  return { ...resolveReference(document, target, next), ...siblings };
}

function normalizeOas(value, kind, document, reference) {
  if (!isObject(value)) return literal(value);
  if (["parameter", "requestBody", "response", "example", "securityScheme"].includes(kind)) {
    value = resolveReference(document, value);
  }
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (isDecoration(key)) continue;
    if ((key === "description" || key === "summary") && child === "") continue;
    if (["deprecated", "required", "allowEmptyValue", "allowReserved"].includes(key) && child === false) continue;
    if (key === "schema") {
      result[key] = normalizeSchema(child);
    } else if (key === "example" || key === "default" || key === "value") {
      // Apifox adds an empty example to path parameters with no source example.
      // Drop that generated placeholder only when the candidate has no example;
      // an explicit source empty-string example must still survive readback.
      const placeholder = kind === "parameter" && key === "example" && child === "" && reference &&
        !has(reference, "example") && !has(reference, "examples") &&
        !has(reference.schema ?? {}, "example") && !has(reference.schema ?? {}, "examples");
      if (!placeholder) result[key] = literal(child);
    } else if (OAS_MAPS[key] && isObject(child)) {
      if (!emptyObject(child)) {
        result[key] = Object.fromEntries(Object.entries(child).map(([name, item]) =>
          [name, normalizeOas(item, OAS_MAPS[key], document)],
        ));
      }
    } else if (key === "requestBody") {
      result[key] = normalizeOas(child, "requestBody", document);
    } else if (key === "parameters" && Array.isArray(child)) {
      if (child.length > 0) result[key] = unordered(child.map((item) => normalizeOas(item, "parameter", document)));
    } else if (key === "tags" && Array.isArray(child)) {
      if (child.length > 0) result[key] = unordered(child);
    } else {
      result[key] = literal(child);
    }
  }
  return literal(result);
}

function parametersOf(document, pathItem, operation) {
  const parameters = new Map();
  for (const parameter of [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])]) {
    const resolved = resolveReference(document, parameter);
    parameters.set(JSON.stringify([resolved.in, resolved.name]), resolved);
  }
  return parameters;
}

function normalizeSecurity(security) {
  if (!Array.isArray(security)) throw new Error("OpenAPI security must be an array");
  return unordered(security.map((requirement) => {
    if (!isObject(requirement)) throw new Error("Invalid OpenAPI security requirement");
    return Object.fromEntries(Object.entries(requirement).map(([name, scopes]) => {
      if (!Array.isArray(scopes)) throw new Error("OpenAPI security scopes must be an array");
      return [name, unordered(scopes)];
    }));
  }));
}

function normalizeServers(servers) {
  if (!Array.isArray(servers)) throw new Error("OpenAPI servers must be an array");
  return servers.map((server) => {
    if (!isObject(server) || typeof server.url !== "string") throw new Error("Invalid OpenAPI server URL");
    // The export uses the environment name as its description. Routing depends
    // on the URL and variable definitions, not that generated display label.
    const { description, ...value } = server;
    return literal({ ...value, url: server.url.replace(/\/+$/, "") });
  });
}

function operationsOf(document) {
  const operations = new Map();
  for (const [path, item] of Object.entries(document.paths)) {
    const pathItem = resolveReference(document, item);
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method.toLowerCase())) continue;
      if (!isObject(operation)) throw new Error("Invalid OpenAPI operation");
      const key = `${method.toUpperCase()} ${path}`;
      if (operations.has(key)) throw new Error("Duplicate OpenAPI operation");
      operations.set(key, { operation, pathItem });
    }
  }
  return operations;
}

function normalizeContract(document, { verifyServers, candidate }) {
  if (!isObject(document) || !/^3\.1(?:\.|$)/.test(document.openapi ?? "") || !isObject(document.paths)) {
    throw new Error("Contract verification requires an OpenAPI 3.1 document with paths");
  }
  const expectedOperations = candidate ? operationsOf(candidate) : new Map();
  const operations = {};
  for (const [name, { operation, pathItem }] of operationsOf(document)) {
    const { parameters, security, servers, ...rest } = operation;
    const normalized = normalizeOas(rest, "operation", document);
    const expected = expectedOperations.get(name);
    const expectedParameters = expected ? parametersOf(candidate, expected.pathItem, expected.operation) : new Map();
    const effectiveParameters = parametersOf(document, pathItem, operation);
    if (effectiveParameters.size > 0) {
      normalized.parameters = Object.fromEntries([...effectiveParameters].map(([key, parameter]) =>
        [key, normalizeOas(parameter, "parameter", document, expectedParameters.get(key))],
      ));
    }
    normalized.security = normalizeSecurity(has(operation, "security") ? security :
      has(document, "security") ? document.security : []);
    for (const key of ["summary", "description"]) {
      if (pathItem[key]) normalized[`pathItem.${key}`] = pathItem[key];
    }
    if (verifyServers) normalized.servers = normalizeServers(servers ?? pathItem.servers ?? document.servers ?? []);
    operations[name] = normalized;
  }
  const components = {};
  for (const [kind, entries] of Object.entries(document.components ?? {})) {
    if (isDecoration(kind) || emptyObject(entries)) continue;
    if (!isObject(entries)) throw new Error("Invalid OpenAPI components collection");
    components[kind] = Object.fromEntries(Object.entries(entries).map(([name, value]) => [name,
      kind === "schemas" ? normalizeSchema(value) :
        normalizeOas(value, kind === "parameters" ? "parameter" : OAS_MAPS[kind] ?? "object", document),
    ]));
  }
  // Keep an empty schemas collection so a missing collection and {} agree.
  components.schemas ??= {};
  const result = { operations, components };
  if (document.webhooks && !emptyObject(document.webhooks)) result.webhooks = literal(document.webhooks);
  return literal(result);
}

function differences(expected, actual, path = "", result = []) {
  if (JSON.stringify(expected) === JSON.stringify(actual)) return result;
  if (isObject(expected) && isObject(actual)) {
    for (const key of [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort()) {
      const next = `${path}/${key}`;
      if (!has(expected, key)) result.push(`${next} (unexpected)`);
      else if (!has(actual, key)) result.push(`${next} (missing)`);
      else differences(expected[key], actual[key], next, result);
    }
  } else if (Array.isArray(expected) && Array.isArray(actual) && expected.length === actual.length) {
    for (let index = 0; index < expected.length; index++) differences(expected[index], actual[index], `${path}/${index}`, result);
  } else {
    result.push(path);
  }
  return result;
}

export function verifyContract(candidate, actual, { verifyServers = false } = {}) {
  const expected = normalizeContract(candidate, { verifyServers });
  const received = normalizeContract(actual, { verifyServers, candidate });
  const changed = differences(expected, received);
  if (changed.length > 0) {
    const locations = changed.slice(0, 12).map((value) => value.replace(/[\r\n\x00-\x1f]/g, " ").slice(0, 240));
    const error = new Error(`Apifox contract mismatch (${changed.length} differences): ${locations.join("; ")}${changed.length > locations.length ? "; …" : ""}`);
    error.differences = changed;
    throw error;
  }
  return {
    operations: Object.keys(expected.operations).length,
    schemas: Object.keys(expected.components.schemas).length,
  };
}

export function createExportPayload(environmentIds = []) {
  const ids = environmentIds.map((value) => {
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Apifox environment IDs must be positive integers");
    return id;
  });
  return {
    scope: { type: "ALL" },
    options: { includeApifoxExtensionProperties: false, addFoldersToTags: false },
    oasVersion: "3.1",
    exportFormat: "JSON",
    ...(ids.length > 0 ? { environmentIds: [...new Set(ids)] } : {}),
  };
}

export async function exportOpenApi(projectId, token, { environmentIds = [], fetchImpl = fetch } = {}) {
  if (!/^[1-9][0-9]*$/.test(String(projectId))) throw new Error("APIFOX_PROJECT_ID must be a positive integer");
  if (typeof token !== "string" || token.trim() === "") throw new Error("APIFOX_ACCESS_TOKEN is required");
  const body = JSON.stringify(createExportPayload(environmentIds));
  let response;
  try {
    response = await fetchImpl(`https://api.apifox.com/v1/projects/${projectId}/export-openapi`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(60_000),
      headers: {
        Accept: "application/json", "Content-Type": "application/json",
        Authorization: `Bearer ${token}`, "X-Apifox-Api-Version": "2024-03-28",
      },
      body,
    });
  } catch {
    throw new Error("Apifox OpenAPI export request failed");
  }
  if (!response.ok) throw new Error(`Apifox OpenAPI export failed with HTTP ${response.status}`);
  let document;
  try {
    document = JSON.parse(await response.text());
  } catch {
    throw new Error("Apifox OpenAPI export did not return JSON");
  }
  if (!isObject(document) || !/^3\.1(?:\.|$)/.test(document.openapi ?? "") || !isObject(document.paths)) {
    throw new Error("Apifox export did not return a direct OpenAPI 3.1 document");
  }
  return document;
}

async function main() {
  const args = new Map();
  const argv = process.argv.slice(2);
  for (let index = 0; index < argv.length; index += 2) {
    if (!["--spec", "--environment", "--exported-spec"].includes(argv[index]) || !argv[index + 1] || args.has(argv[index])) {
      throw new Error("Usage: node apifox-verify-contract.mjs --spec FILE [--environment ID] [--exported-spec FILE]");
    }
    args.set(argv[index], argv[index + 1]);
  }
  if (!args.has("--spec")) throw new Error("--spec is required");
  const candidate = JSON.parse(readFileSync(resolve(args.get("--spec")), "utf8"));
  const environmentIds = args.has("--environment") ? [args.get("--environment")] : [];
  createExportPayload(environmentIds);
  const actual = args.has("--exported-spec")
    ? JSON.parse(readFileSync(resolve(args.get("--exported-spec")), "utf8"))
    : await exportOpenApi(process.env.APIFOX_PROJECT_ID, process.env.APIFOX_ACCESS_TOKEN, { environmentIds });
  const result = verifyContract(candidate, actual, { verifyServers: environmentIds.length > 0 });
  console.log(`Verified Apifox contract content: ${result.operations} HTTP operations, ${result.schemas} schemas, effective authentication, request/response documentation${environmentIds.length > 0 ? ", and API servers" : ""}.`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    await main();
  } catch (error) {
    const token = process.env.APIFOX_ACCESS_TOKEN;
    const message = error instanceof Error ? error.message : "Apifox verification failed";
    console.error(`::error::${(token ? message.split(token).join("***") : message).replace(/[\r\n]/g, " ")}`);
    process.exitCode = 1;
  }
}
