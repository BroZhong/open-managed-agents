import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createImportPayload,
  validateImportResponse,
} from "./apifox-import.mjs";

function response(overrides = {}) {
  return {
    data: {
      counters: {
        endpointCreated: 0,
        endpointUpdated: 62,
        endpointFailed: 0,
        endpointIgnored: 0,
        schemaCreated: 0,
        schemaUpdated: 53,
        schemaFailed: 0,
        schemaIgnored: 0,
        endpointFolderFailed: 0,
        schemaFolderFailed: 0,
        ...overrides,
      },
    },
  };
}

test("uses the official overwrite and exact-sync import options", () => {
  const document = { openapi: "3.1.0", paths: {} };

  assert.deepEqual(createImportPayload(document), {
    input: JSON.stringify(document),
    options: {
      endpointOverwriteBehavior: "OVERWRITE_EXISTING",
      schemaOverwriteBehavior: "OVERWRITE_EXISTING",
      updateFolderOfChangedEndpoint: true,
      prependBasePath: false,
      deleteUnmatchedResources: true,
    },
  });
});

test("accepts complete overwrite counters for the generated contract", () => {
  const document = JSON.parse(readFileSync("docs/openapi.json", "utf8"));

  assert.deepEqual(validateImportResponse(document, response()), {
    endpointCreated: 0,
    endpointUpdated: 62,
    endpointIgnored: 0,
    schemaCreated: 0,
    schemaUpdated: 53,
    schemaIgnored: 0,
    expectedEndpoints: 62,
    expectedSchemas: 53,
  });
});

test("accepts a first import that creates every resource", () => {
  const document = JSON.parse(readFileSync("docs/openapi.json", "utf8"));

  assert.deepEqual(
    validateImportResponse(
      document,
      response({
        endpointCreated: 62,
        endpointUpdated: 0,
        schemaCreated: 53,
        schemaUpdated: 0,
      }),
    ),
    {
      endpointCreated: 62,
      endpointUpdated: 0,
      endpointIgnored: 0,
      schemaCreated: 53,
      schemaUpdated: 0,
      schemaIgnored: 0,
      expectedEndpoints: 62,
      expectedSchemas: 53,
    },
  );
});

test("accepts unchanged resources as processed pending semantic readback", () => {
  const document = JSON.parse(readFileSync("docs/openapi.json", "utf8"));
  const result = validateImportResponse(document, response({
    endpointUpdated: 61, endpointIgnored: 1,
    schemaUpdated: 1, schemaIgnored: 52,
  }));
  assert.equal(result.endpointIgnored, 1);
  assert.equal(result.schemaIgnored, 52);
});

test("accepts observed endpoint counters that omit unchanged endpoints", () => {
  const document = JSON.parse(readFileSync("docs/openapi.json", "utf8"));
  const result = validateImportResponse(document, response({
    endpointUpdated: 17,
    schemaUpdated: 1, schemaIgnored: 52,
  }));
  assert.equal(result.endpointUpdated, 17);
  assert.equal(result.expectedEndpoints, 62);
});

test("rejects failed resources and impossible counter totals", () => {
  const document = JSON.parse(readFileSync("docs/openapi.json", "utf8"));

  assert.throws(
    () =>
      validateImportResponse(
        document,
        response({ endpointUpdated: 62, endpointFailed: 1 }),
      ),
    /did not overwrite every endpoint/i,
  );
  assert.throws(
    () =>
      validateImportResponse(
        document,
        response({ schemaUpdated: 51, schemaFailed: 1 }),
      ),
    /did not overwrite every schema/i,
  );
  assert.throws(
    () => validateImportResponse(document, response({ endpointUpdated: 64 })),
    /processed 64 endpoints instead of 62/i,
  );
  assert.throws(
    () => validateImportResponse(document, response({ schemaUpdated: 54 })),
    /processed 54 schemas instead of 53/i,
  );
  assert.throws(
    () => validateImportResponse(document, response({ securitySchemeFailed: 1 })),
    /securitySchemeFailed failures/i,
  );
});

test("rejects malformed counters and folder failures", () => {
  const document = JSON.parse(readFileSync("docs/openapi.json", "utf8"));

  assert.throws(
    () => validateImportResponse(document, response({ endpointUpdated: -1 })),
    /invalid endpointUpdated counter/i,
  );
  assert.throws(
    () =>
      validateImportResponse(document, response({ endpointFolderFailed: 1 })),
    /folder synchronization failed/i,
  );
  assert.throws(
    () => validateImportResponse(document, { data: {} }),
    /invalid response envelope/i,
  );
  assert.throws(
    () =>
      validateImportResponse(document, {
        ...response(),
        data: {
          ...response().data,
          errors: [{ code: "403", message: "Import already running" }],
        },
      }),
    /reported errors.*403/i,
  );
});
