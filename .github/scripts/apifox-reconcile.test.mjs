import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  assertSafeTargetInventory,
  createReconciliationPlan,
  operationsFromOpenApi,
} from "./apifox-reconcile.mjs";

const requiredOperations = [
  { method: "GET", path: "/health" },
  { method: "GET", path: "/openapi.json" },
];

test("accepts the repository's generated OpenAPI inventory", () => {
  const document = JSON.parse(readFileSync("docs/openapi.json", "utf8"));
  const desired = operationsFromOpenApi(document);
  const remote = desired.map((operation, index) => ({
    id: index + 1,
    ...operation,
  }));

  assert.equal(desired.length, 54);
  assert.deepEqual(createReconciliationPlan(desired, remote, 0), {
    deleteEndpoints: [],
  });
});

test("extracts HTTP operations from an OpenAPI document", () => {
  const operations = operationsFromOpenApi({
    paths: {
      "/health": { get: {}, parameters: [] },
      "/widgets/{id}": { get: {}, delete: {}, summary: "ignored" },
    },
  });

  assert.deepEqual(operations, [
    { method: "DELETE", path: "/widgets/{id}" },
    { method: "GET", path: "/health" },
    { method: "GET", path: "/widgets/{id}" },
  ]);
});

test("plans only unmatched endpoint deletions after a complete import", () => {
  const desired = [
    ...requiredOperations,
    { method: "POST", path: "/v1/widgets" },
  ];
  const remote = [
    { id: 1, method: "get", path: "/health" },
    { id: 2, method: "GET", path: "/openapi.json" },
    { id: 3, method: "post", path: "/v1/widgets" },
    { id: 4, method: "GET", path: "/obsolete" },
  ];

  assert.deepEqual(createReconciliationPlan(desired, remote, 2), {
    deleteEndpoints: [
      { id: 4, method: "GET", path: "/obsolete" },
    ],
  });
});

test("preflight accepts a new project or an earlier managed inventory", () => {
  assert.doesNotThrow(() => assertSafeTargetInventory(requiredOperations, []));
  assert.doesNotThrow(() =>
    assertSafeTargetInventory(requiredOperations, [
      { id: 1, method: "GET", path: "/health" },
      { id: 2, method: "GET", path: "/openapi.json" },
      { id: 3, method: "GET", path: "/removed-in-next-version" },
    ]),
  );
});

test("preflight blocks a non-empty unrelated project before import", () => {
  assert.throws(
    () =>
      assertSafeTargetInventory(requiredOperations, [
        { id: 1, method: "GET", path: "/someone-elses-api" },
      ]),
    /not an empty or previously managed project/i,
  );
});

test("refuses deletion when import is incomplete", () => {
  assert.throws(
    () =>
      createReconciliationPlan(
        [...requiredOperations, { method: "POST", path: "/v1/widgets" }],
        requiredOperations.map((operation, index) => ({
          id: index + 1,
          ...operation,
        })),
        10,
      ),
    /missing desired operations.*POST \/v1\/widgets/i,
  );
});

test("refuses ambiguous remote duplicates and oversized deletion plans", () => {
  assert.throws(
    () =>
      createReconciliationPlan(
        requiredOperations,
        [
          { id: 1, method: "GET", path: "/health" },
          { id: 2, method: "GET", path: "/health" },
          { id: 3, method: "GET", path: "/openapi.json" },
        ],
        10,
      ),
    /duplicate remote operation/i,
  );

  assert.throws(
    () =>
      createReconciliationPlan(
        requiredOperations,
        [
          { id: 1, method: "GET", path: "/health" },
          { id: 2, method: "GET", path: "/openapi.json" },
          { id: 3, method: "GET", path: "/old-a" },
          { id: 4, method: "GET", path: "/old-b" },
        ],
        1,
      ),
    /exceeds the safety limit/i,
  );
});

test("requires repository sentinel operations before any reconciliation", () => {
  assert.throws(
    () =>
      createReconciliationPlan(
        [{ method: "GET", path: "/health" }],
        [{ id: 1, method: "GET", path: "/health" }],
        10,
      ),
    /sentinel operation.*GET \/openapi\.json/i,
  );
});
