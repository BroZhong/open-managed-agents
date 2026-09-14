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
        endpointUpdated: 54,
        endpointFailed: 0,
        endpointIgnored: 0,
        schemaCreated: 0,
        schemaUpdated: 49,
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
    endpointUpdated: 54,
    schemaCreated: 0,
    schemaUpdated: 49,
    expectedEndpoints: 54,
    expectedSchemas: 49,
  });
});

test("accepts a first import that creates every resource", () => {
  const document = JSON.parse(readFileSync("docs/openapi.json", "utf8"));

  assert.deepEqual(
    validateImportResponse(
      document,
      response({
        endpointCreated: 54,
        endpointUpdated: 0,
        schemaCreated: 49,
        schemaUpdated: 0,
      }),
    ),
    {
      endpointCreated: 54,
      endpointUpdated: 0,
      schemaCreated: 49,
      schemaUpdated: 0,
      expectedEndpoints: 54,
      expectedSchemas: 49,
    },
  );
});

test("rejects ignored, failed, or incomplete resources", () => {
  const document = JSON.parse(readFileSync("docs/openapi.json", "utf8"));

  assert.throws(
    () =>
      validateImportResponse(
        document,
        response({ endpointUpdated: 53, endpointIgnored: 1 }),
      ),
    /did not overwrite every endpoint/i,
  );
  assert.throws(
    () =>
      validateImportResponse(
        document,
        response({ schemaUpdated: 48, schemaFailed: 1 }),
      ),
    /did not overwrite every schema/i,
  );
  assert.throws(
    () => validateImportResponse(document, response({ endpointUpdated: 53 })),
    /processed 53 endpoints instead of 54/i,
  );
  assert.throws(
    () => validateImportResponse(document, response({ schemaUpdated: 48 })),
    /processed 48 schemas instead of 49/i,
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
