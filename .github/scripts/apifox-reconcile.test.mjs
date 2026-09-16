import test from "node:test";
import assert from "node:assert/strict";
import { fstatSync, readFileSync, writeSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  assertSafeTargetInventory,
  listEndpoints,
  runApifox,
  parseEndpointInventory,
  createPreflightDeletionPlan,
  createReconciliationPlan,
  createSchemaDeletionPlan,
  operationsFromOpenApi,
  schemaNamesFromOpenApi,
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

  assert.equal(desired.length, 56);
  assert.ok(desired.some((operation) =>
    operation.method === "POST" && operation.path === "/v1/sessions/{id}"
  ));
  assert.ok(desired.some((operation) =>
    operation.method === "DELETE" && operation.path === "/v1/workspaces/{id}"
  ));
  assert.ok(desired.some((operation) =>
    operation.method === "GET" && operation.path === "/v1/sessions/{id}/pending"
  ));
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

test("extracts sorted schema names from an OpenAPI document", () => {
  assert.deepEqual(
    schemaNamesFromOpenApi({
      paths: {},
      components: { schemas: { Zebra: {}, Alpha: {} } },
    }),
    ["Alpha", "Zebra"],
  );
  assert.deepEqual(schemaNamesFromOpenApi({ paths: {} }), []);
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

test("preflight enforces the deletion limit before the import API can delete", () => {
  const remote = [
    { id: 1, method: "GET", path: "/health" },
    { id: 2, method: "GET", path: "/openapi.json" },
    { id: 3, method: "GET", path: "/old-a" },
    { id: 4, method: "GET", path: "/old-b" },
  ];

  assert.deepEqual(createPreflightDeletionPlan(requiredOperations, remote, 2), {
    deleteEndpoints: [
      { id: 3, method: "GET", path: "/old-a" },
      { id: 4, method: "GET", path: "/old-b" },
    ],
  });
  assert.throws(
    () => createPreflightDeletionPlan(requiredOperations, remote, 1),
    /exceeds the safety limit/i,
  );
});

test("preflight and reconciliation bound schema deletion by name", () => {
  const desired = ["CurrentA", "CurrentB"];
  const remote = [
    { id: 1, name: "CurrentA" },
    { id: 2, name: "CurrentB" },
    { id: 3, name: "Obsolete" },
  ];

  assert.deepEqual(createSchemaDeletionPlan(desired, remote, 1), {
    deleteSchemas: [{ id: 3, name: "Obsolete" }],
  });
  assert.throws(
    () => createSchemaDeletionPlan(desired, remote, 0),
    /schema deletion plan.*exceeds the safety limit/i,
  );
  assert.throws(
    () =>
      createSchemaDeletionPlan(
        [...desired, "Missing"],
        remote,
        1,
        { requireComplete: true },
      ),
    /missing desired schemas.*Missing/i,
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

function inventoryEnvelope(data, meta = {}, projectId = "8578928") {
  return JSON.stringify({
    success: true, context: { projectId }, data,
    meta: { total: data.length, returned: data.length, page: 1,
      pageSize: data.length, totalPages: 1, prevPage: null, nextPage: null, ...meta },
  });
}

const inventoryRows = [
  { id: 486704014, method: "get", path: "/v1/skills" },
  { id: 515382553, method: "put", path: "/v1/workspaces/{id}/files/content" },
];

test("retrieves all endpoints in one CLI request without pagination flags", () => {
  const calls = [];
  const result = listEndpoints("8578928", "test-token", (args, token) => {
    calls.push({ args, token });
    return inventoryEnvelope(inventoryRows);
  });
  assert.deepEqual(calls, [{ args: ["endpoint", "list", "--project", "8578928"], token: "test-token" }]);
  assert.deepEqual(result.map((row) => row.id), [486704014, 515382553]);
  assert.equal(result[0].method, "GET");
});

test("rejects the observed repeated-ID/missing-endpoint response instead of deduplicating", () => {
  assert.throws(() => parseEndpointInventory(inventoryEnvelope([
    inventoryRows[0], inventoryRows[0],
  ]), "8578928"), /Duplicate remote endpoint ID/);
});

test("rejects genuinely duplicate operations with different IDs", () => {
  assert.throws(() => parseEndpointInventory(inventoryEnvelope([
    inventoryRows[0], { ...inventoryRows[0], id: 99, method: "GET" },
  ]), "8578928"), /Duplicate remote operation/);
});

test("rejects partial, truncated and contradictory full-response metadata", () => {
  for (const meta of [
    { total: 3 }, { returned: 1 }, { nextPage: 2 }, { prevPage: 1 },
    { page: 2 }, { totalPages: 2 }, { total: -1 }, { total: "2" },
    { total: undefined }, { returned: undefined }, { nextPage: undefined },
  ]) {
    assert.throws(() => parseEndpointInventory(inventoryEnvelope(inventoryRows, meta), "8578928"), /incomplete/);
  }
});

test("accepts complete empty and greater-than-one-page inventories", () => {
  for (const totalPages of [0, 1]) {
    assert.deepEqual(parseEndpointInventory(inventoryEnvelope([], { totalPages }), "8578928"), []);
  }
  const rows = Array.from({ length: 501 }, (_, index) => ({ id: index + 1, method: "get", path: `/items/${index}` }));
  assert.equal(parseEndpointInventory(inventoryEnvelope(rows), "8578928").length, 501);
});

test("rejects malformed envelopes, foreign projects and invalid endpoint IDs", () => {
  for (const raw of ["not JSON", "null", JSON.stringify({ success: false }), inventoryEnvelope([], {}, "other")]) {
    assert.throws(() => parseEndpointInventory(raw, "8578928"));
  }
  for (const id of [undefined, 0, -1, "1", 1.5]) {
    assert.throws(() => parseEndpointInventory(inventoryEnvelope([{ ...inventoryRows[0], id }]), "8578928"), /positive integer id/);
  }
});

test("captures complete CLI JSON even when the child exits immediately after a large write", () => {
  const output = runApifox(["endpoint", "list"], "test-token", (_command, _args, options) => {
    assert.equal(fstatSync(options.stdio[1]).mode & 0o777, 0o600);
    return execFileSync(process.execPath, ["-e", 'process.stdout.write(JSON.stringify({value:"x".repeat(100000)})); process.exit(0);'], options);
  });
  assert.equal(JSON.parse(output).value.length, 100000);
});

test("closes temporary output on command failure and redacts credentials", () => {
  let fd;
  assert.throws(() => runApifox([], "test-secret", (_command, _args, options) => {
    fd = options.stdio[1];
    writeSync(fd, 'failure: test-secret');
    throw new Error("CLI exit 1");
  }), (error) => error.message.includes("failure: ***") && !error.message.includes("test-secret"));
  assert.throws(() => fstatSync(fd), /EBADF/);
});

test("fails closed on oversized CLI output and closes its output descriptor", () => {
  let fd;
  assert.throws(() => runApifox([], "test-token", (_command, _args, options) => {
    fd = options.stdio[1];
    writeSync(fd, Buffer.alloc(16 * 1024 * 1024 + 1));
  }), /16 MiB/);
  assert.throws(() => fstatSync(fd), /EBADF/);
});
