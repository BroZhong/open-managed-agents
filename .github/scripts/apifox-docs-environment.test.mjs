import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDocsSiteEnvironmentUpdate,
  selectPublicApiEnvironment,
  verifyDocsSiteEnvironmentBinding,
} from "./apifox-docs-environment.mjs";

function environments(data) {
  return { success: true, data };
}

function docsSite(environmentSettings, overrides = {}) {
  return {
    success: true,
    data: {
      id: 123,
      projectId: 456,
      environments: environmentSettings,
      ...overrides,
    },
  };
}

test("selects the unique environment whose default base URL matches PUBLIC_API_URL", () => {
  const selected = selectPublicApiEnvironment(
    environments([
      {
        id: 10,
        name: "same name is not enough",
        baseUrls: { default: "https://other.example.com" },
      },
      {
        id: 20,
        name: "Production",
        baseUrls: { default: "https://api.example.com" },
      },
      {
        id: 30,
        baseUrl: "https://api.example.com",
        baseUrls: { secondary: "https://api.example.com" },
      },
    ]),
    " https://api.example.com/ ",
  );

  assert.equal(selected.id, 20);
});

test("rejects missing and ambiguous environment matches", () => {
  assert.throws(
    () =>
      selectPublicApiEnvironment(
        environments([
          { id: 10, baseUrls: { default: "https://other.example.com" } },
        ]),
        "https://api.example.com",
      ),
    /no Apifox environment/i,
  );

  assert.throws(
    () =>
      selectPublicApiEnvironment(
        environments([
          { id: 10, baseUrls: { default: "https://api.example.com" } },
          { id: 20, baseUrls: { default: "https://api.example.com" } },
        ]),
        "https://api.example.com",
      ),
    /multiple Apifox environments/i,
  );
});

test("preserves the complete docs-site environments object while replacing its binding", () => {
  const originalSettings = {
    environmentIds: [99],
    defaultEnvironmentId: 99,
    visibility: { mode: "selected", inherited: true },
    variables: [{ name: "region", enabled: true }],
  };
  const envelope = docsSite(originalSettings);

  assert.deepEqual(
    buildDocsSiteEnvironmentUpdate(envelope, {
      projectId: "456",
      siteId: "123",
      environmentId: 20,
    }),
    {
      environments: {
        environmentIds: [20],
        defaultEnvironmentId: 20,
        visibility: { mode: "selected", inherited: true },
        variables: [{ name: "region", enabled: true }],
      },
    },
  );
  assert.deepEqual(envelope.data.environments, originalSettings);
});

test("refuses to replace an absent environments object or a mismatched docs site", () => {
  assert.throws(
    () =>
      buildDocsSiteEnvironmentUpdate(docsSite(undefined), {
        projectId: "456",
        siteId: "123",
        environmentId: 20,
      }),
    /complete environments object/i,
  );
  assert.throws(
    () =>
      buildDocsSiteEnvironmentUpdate(docsSite({}), {
        projectId: "999",
        siteId: "123",
        environmentId: 20,
      }),
    /identity does not match/i,
  );
});

test("verifies the exact single environment binding returned after update", () => {
  assert.equal(
    verifyDocsSiteEnvironmentBinding(
      docsSite({ environmentIds: [20], defaultEnvironmentId: 20 }),
      { projectId: "456", siteId: "123", environmentId: 20 },
    ),
    20,
  );

  for (const settings of [
    { environmentIds: [], defaultEnvironmentId: 20 },
    { environmentIds: [20, 30], defaultEnvironmentId: 20 },
    { environmentIds: [20], defaultEnvironmentId: 30 },
  ]) {
    assert.throws(
      () =>
        verifyDocsSiteEnvironmentBinding(docsSite(settings), {
          projectId: "456",
          siteId: "123",
          environmentId: 20,
        }),
      /environment binding was not applied/i,
    );
  }
});
