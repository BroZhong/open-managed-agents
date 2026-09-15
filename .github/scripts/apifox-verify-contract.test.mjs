import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createExportPayload, exportOpenApi, verifyContract } from "./apifox-verify-contract.mjs";

function contract() {
  return {
    openapi: "3.1.0",
    info: { title: "Example API", version: "1" },
    servers: [{ url: "https://api.example.com/api" }],
    security: [{ ApiKey: [] }, { Bearer: [] }],
    paths: {
      "/health": {
        get: {
          operationId: "health", security: [],
          responses: { 200: { description: "Healthy" } },
        },
      },
      "/v1/sessions/{id}/events": {
        parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }],
        post: {
          operationId: "sendEvent", tags: ["Sessions", "Events"],
          description: "Queues input and returns its identifier.",
          requestBody: {
            required: true,
            content: { "application/json": {
              schema: { $ref: "#/components/schemas/UserEvent" },
              examples: { message: { summary: "Send input", value: { type: "user.message", data: { text: "Hello" } } } },
            } },
          },
          responses: { 202: {
            description: "Input accepted",
            content: { "application/json": {
              schema: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
              example: { id: "input_1" },
            } },
          } },
        },
      },
    },
    components: {
      schemas: {
        UserEvent: {
          type: "object", required: ["type", "data"], additionalProperties: false,
          properties: {
            type: { type: "string", enum: ["user.message", "interrupt"] },
            data: {},
            label: { type: ["string", "null"], example: "input", description: "Optional label" },
          },
          example: { type: "user.message", data: { text: "Hello" } },
        },
      },
      securitySchemes: {
        ApiKey: { type: "apiKey", in: "header", name: "x-api-key", description: "Machine credential" },
        Bearer: { type: "http", scheme: "bearer", description: "User session" },
      },
      parameters: {},
    },
  };
}

const eventOperation = (document) => document.paths["/v1/sessions/{id}/events"].post;
const media = (document) => eventOperation(document).requestBody.content["application/json"];

function assertDifference(expected, actual, pattern, options) {
  assert.throws(() => verifyContract(expected, actual, options), (error) => {
    assert.match(error.message, /Apifox contract mismatch/);
    assert.ok(error.differences.some((path) => pattern.test(path)), error.differences.join("\n"));
    return true;
  });
}

test("accepts the same contract without mutating either input", () => {
  const candidate = contract();
  const before = JSON.stringify(candidate);
  assert.deepEqual(verifyContract(candidate, structuredClone(candidate)), { operations: 2, schemas: 1 });
  assert.equal(JSON.stringify(candidate), before);
});

test("accepts exporter metadata, nullable, schema examples and unordered set differences", () => {
  const candidate = contract();
  const actual = structuredClone(candidate);
  actual["x-apifox-project-id"] = 123;
  const operation = eventOperation(actual);
  operation["x-apifox-status"] = "released";
  operation.deprecated = false;
  operation.tags.reverse();
  operation.security = [{ Bearer: [] }, { ApiKey: [] }];
  operation.responses[202].headers = {};
  actual.paths["/health"].get.parameters = [];
  actual.paths["/health"].get.summary = "";
  actual.paths["/health"].get.description = "";
  const schema = actual.components.schemas.UserEvent;
  schema.required.reverse();
  schema.properties.type.enum.reverse();
  schema.properties.data.properties = {};
  schema.properties.data.additionalProperties = true;
  schema.properties.label = {
    type: "string", nullable: true, examples: ["input"], example: "input",
    description: "Optional label", deprecated: false, readOnly: false,
  };
  schema.examples = [schema.example];
  delete schema.example;
  actual.components.responses = {};
  delete actual.components.parameters;
  actual.paths["/v1/sessions/{id}/events"].parameters[0].example = "";
  assert.deepEqual(verifyContract(candidate, actual), { operations: 2, schemas: 1 });
});

test("checks complete operation and schema sets", () => {
  for (const [modify, pattern] of [
    [(doc) => { delete doc.paths["/health"]; }, /GET \/health.*missing/],
    [(doc) => { doc.paths["/legacy"] = structuredClone(doc.paths["/health"]); }, /GET \/legacy.*unexpected/],
    [(doc) => { delete doc.components.schemas.UserEvent; }, /schemas\/UserEvent.*missing/],
    [(doc) => { doc.components.schemas.StaleSchema = { type: "string" }; }, /schemas\/StaleSchema.*unexpected/],
  ]) {
    const candidate = contract();
    const actual = structuredClone(candidate);
    modify(actual);
    assertDifference(candidate, actual, pattern);
  }
});

test("rejects unknown data silently narrowed to a string and other schema constraints", () => {
  for (const [modify, pattern] of [
    [(s) => { s.properties.data.type = "string"; }, /UserEvent\/properties\/data\/type/],
    [(s) => { s.required = ["type"]; }, /UserEvent\/required/],
    [(s) => { delete s.additionalProperties; }, /UserEvent\/additionalProperties/],
    [(s) => { s.properties.type.enum.pop(); }, /UserEvent\/properties\/type\/enum/],
    [(s) => { s.properties.label.type = "string"; }, /UserEvent\/properties\/label\/type/],
    [(s) => { s.properties.label.description = "A different meaning"; }, /label\/description/],
  ]) {
    const candidate = contract();
    const actual = structuredClone(candidate);
    modify(actual.components.schemas.UserEvent);
    assertDifference(candidate, actual, pattern);
  }
});

test("preserves literal JSON example values and property names", () => {
  const candidate = contract();
  const schema = candidate.components.schemas.UserEvent;
  schema.properties["x-apifox-business-field"] = { type: "boolean" };
  schema.examples = [false, 0, "", null, { "x-apifox-value": 1, properties: {}, required: [] }];
  delete schema.example;
  const equivalent = structuredClone(candidate);
  equivalent.components.schemas.UserEvent.examples.reverse();
  verifyContract(candidate, equivalent);
  for (const index of [0, 1, 2, 3, 4]) {
    const actual = structuredClone(candidate);
    actual.components.schemas.UserEvent.examples[index] = "changed";
    assertDifference(candidate, actual, /UserEvent\/examples/);
  }
  const actual = structuredClone(candidate);
  delete actual.components.schemas.UserEvent.properties["x-apifox-business-field"];
  assertDifference(candidate, actual, /x-apifox-business-field/);
});

test("compares effective security, preserving public overrides and OR versus AND", () => {
  const candidate = contract();
  const expanded = structuredClone(candidate);
  eventOperation(expanded).security = candidate.security;
  delete expanded.security;
  verifyContract(candidate, expanded);
  for (const [modify, pattern] of [
    [(doc) => { eventOperation(doc).security = []; }, /POST.*\/security/],
    [(doc) => { delete doc.paths["/health"].get.security; }, /GET \/health\/security/],
    [(doc) => { eventOperation(doc).security = [{ ApiKey: [], Bearer: [] }]; }, /POST.*\/security/],
    [(doc) => { doc.security = [{ ApiKey: ["admin"] }, { Bearer: [] }]; }, /security/],
    [(doc) => { doc.components.securitySchemes.ApiKey.name = "other-header"; }, /securitySchemes\/ApiKey\/name/],
  ]) {
    const actual = structuredClone(candidate);
    modify(actual);
    assertDifference(candidate, actual, pattern);
  }
  const malformed = structuredClone(candidate);
  eventOperation(malformed).security = null;
  assert.throws(() => verifyContract(candidate, malformed), /security must be an array/);
});

test("detects changed request and response structures, descriptions and examples", () => {
  for (const [modify, pattern] of [
    [(doc) => { delete eventOperation(doc).description; }, /POST.*\/description/],
    [(doc) => { eventOperation(doc).requestBody.required = false; }, /requestBody\/required/],
    [(doc) => { media(doc).schema = { type: "object" }; }, /requestBody\/content.*\/schema/],
    [(doc) => { delete media(doc).examples.message; }, /requestBody\/content.*\/examples/],
    [(doc) => { media(doc).examples.message.value.data.text = "secret-response-value"; }, /examples\/message\/value/],
    [(doc) => { eventOperation(doc).responses[202].description = "Different"; }, /responses\/202\/description/],
    [(doc) => { eventOperation(doc).responses[202].content["application/json"].example.id = "other"; }, /responses\/202\/content.*\/example/],
    [(doc) => { delete eventOperation(doc).responses[202].content; }, /responses\/202\/content/],
  ]) {
    const candidate = contract();
    const actual = structuredClone(candidate);
    modify(actual);
    assertDifference(candidate, actual, pattern);
  }
});

test("fails when a multipart anyOf upload contract becomes an empty object", () => {
  const candidate = contract();
  eventOperation(candidate).requestBody.content = { "multipart/form-data": {
    schema: { anyOf: [
      { type: "object", required: ["file"], properties: { file: { type: "string", format: "binary" } } },
      { type: "object", required: ["files"], properties: { files: { type: "array", minItems: 1, items: { type: "string", format: "binary" } } } },
    ] },
  } };
  const actual = structuredClone(candidate);
  eventOperation(actual).requestBody.content["multipart/form-data"].schema = { type: "object", properties: {} };
  assertDifference(candidate, actual, /multipart\/form-data\/schema\/anyOf.*missing/);
});

test("does not hide explicit empty source examples or placeholders that override schema examples", () => {
  const candidate = contract();
  const parameter = candidate.paths["/v1/sessions/{id}/events"].parameters[0];
  parameter.example = "";
  const actual = structuredClone(candidate);
  delete actual.paths["/v1/sessions/{id}/events"].parameters[0].example;
  assertDifference(candidate, actual, /parameters.*\/example.*missing/);
  delete parameter.example;
  parameter.schema.example = "session_1";
  const override = structuredClone(candidate);
  override.paths["/v1/sessions/{id}/events"].parameters[0].example = "";
  assertDifference(candidate, override, /parameters.*\/example.*unexpected/);
});

test("resolves path-level parameters and operation overrides independent of ordering", () => {
  const candidate = contract();
  const path = candidate.paths["/v1/sessions/{id}/events"];
  path.parameters.push({ name: "include", in: "query", schema: { type: "string" } });
  eventOperation(candidate).parameters = [{ name: "include", in: "query", schema: { type: "string", enum: ["chunks"] } }];
  const actual = structuredClone(candidate);
  actual.components.parameters.SessionId = actual.paths["/v1/sessions/{id}/events"].parameters[0];
  // A referenced component is itself part of the contract, so include it on both sides.
  candidate.components.parameters.SessionId = structuredClone(actual.components.parameters.SessionId);
  eventOperation(actual).parameters.push({ $ref: "#/components/parameters/SessionId" });
  delete actual.paths["/v1/sessions/{id}/events"].parameters;
  eventOperation(actual).parameters.reverse();
  verifyContract(candidate, actual);
  eventOperation(actual).parameters.find((p) => p.name === "include").schema.enum = ["other"];
  assertDifference(candidate, actual, /parameters.*include.*\/enum/);
});

test("checks effective server URLs only when requested, including the API base path", () => {
  const candidate = contract();
  const actual = structuredClone(candidate);
  actual.servers = [{ url: "https://old.example.com" }];
  verifyContract(candidate, actual);
  assertDifference(candidate, actual, /servers\/0\/url/, { verifyServers: true });
  actual.servers = [{ url: "https://api.example.com/api/", description: "Production environment" }];
  verifyContract(candidate, actual, { verifyServers: true });
  eventOperation(actual).servers = [{ url: "https://api.example.com/api/api" }];
  assertDifference(candidate, actual, /POST.*\/servers\/0\/url/, { verifyServers: true });
});

test("rejects non-3.1 documents and unresolved parameter references", () => {
  for (const actual of [{}, { openapi: "3.0.3", paths: {} }, { openapi: "3.1.0" }]) {
    assert.throws(() => verifyContract(contract(), actual), /requires an OpenAPI 3.1 document/);
  }
  const actual = contract();
  eventOperation(actual).parameters = [{ $ref: "#/components/parameters/Missing" }];
  assert.throws(() => verifyContract(contract(), actual), /unresolved OpenAPI reference/);
});

test("builds the official 3.1 export payload with environment IDs at the top level", () => {
  assert.deepEqual(createExportPayload(["49078810", 49078810]), {
    scope: { type: "ALL" },
    options: { includeApifoxExtensionProperties: false, addFoldersToTags: false },
    oasVersion: "3.1", exportFormat: "JSON", environmentIds: [49078810],
  });
  assert.equal(Object.hasOwn(createExportPayload(), "environmentIds"), false);
  for (const value of [0, -1, "invalid", "1.5", Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => createExportPayload([value]), /positive integers/);
  }
});

test("exports through the official endpoint using a direct OpenAPI JSON response", async () => {
  let request;
  const document = contract();
  const result = await exportOpenApi("8578928", "test-token", {
    environmentIds: [49078810],
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify(document), { status: 200 });
    },
  });
  assert.deepEqual(result, document);
  assert.equal(request.url, "https://api.apifox.com/v1/projects/8578928/export-openapi");
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.redirect, "error");
  assert.ok(request.options.signal instanceof AbortSignal);
  assert.equal(request.options.headers.Authorization, "Bearer test-token");
  assert.equal(request.options.headers["X-Apifox-Api-Version"], "2024-03-28");
  assert.deepEqual(JSON.parse(request.options.body), createExportPayload([49078810]));
});

test("export failures never reveal response bodies or credential-bearing transport errors", async () => {
  for (const fetchImpl of [
    async () => { throw new Error("Authorization: Bearer private-token"); },
    async () => new Response("private-token", { status: 401 }),
    async () => new Response("<html>private-token</html>"),
    async () => new Response(JSON.stringify({ data: contract(), message: "private-token" })),
    async () => new Response(JSON.stringify({ ...contract(), openapi: "3.0.3" })),
  ]) {
    await assert.rejects(exportOpenApi("8578928", "private-token", { fetchImpl }), (error) => {
      assert.doesNotMatch(error.message, /private-token/);
      assert.match(error.message, /Apifox/);
      return true;
    });
  }
  await assert.rejects(exportOpenApi("8578928/other", "private-token"), /PROJECT_ID/);
  await assert.rejects(exportOpenApi("8578928", ""), /ACCESS_TOKEN/);
});

test("offline CLI reports counts on success and a concise nonzero diff without values", () => {
  const directory = mkdtempSync(join(tmpdir(), "apifox-contract-test-"));
  try {
    const specPath = join(directory, "candidate.json");
    const exportPath = join(directory, "export.json");
    const script = fileURLToPath(new URL("./apifox-verify-contract.mjs", import.meta.url));
    const candidate = contract();
    writeFileSync(specPath, JSON.stringify(candidate));
    writeFileSync(exportPath, JSON.stringify(candidate));
    const args = [script, "--spec", specPath, "--exported-spec", exportPath, "--environment", "49078810"];
    const success = spawnSync(process.execPath, args, { encoding: "utf8", env: { ...process.env, APIFOX_ACCESS_TOKEN: "" } });
    assert.equal(success.status, 0, success.stderr);
    assert.match(success.stdout, /2 HTTP operations, 1 schemas/);
    assert.match(success.stdout, /API servers/);
    media(candidate).examples.message.value.data.text = "private-value-must-not-appear";
    writeFileSync(exportPath, JSON.stringify(candidate));
    const failure = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.equal(failure.status, 1);
    assert.match(failure.stderr, /contract mismatch/);
    assert.doesNotMatch(failure.stderr, /private-value-must-not-appear/);
    assert.ok(failure.stderr.length < 3500);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
