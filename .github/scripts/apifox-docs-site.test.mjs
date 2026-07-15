import test from "node:test";
import assert from "node:assert/strict";
import { verifyDocumentationSite } from "./apifox-docs-site.mjs";

function site(overrides = {}) {
  return {
    success: true,
    data: {
      id: 123,
      projectId: 456,
      name: "Open Managed Agents API",
      isPrivate: false,
      status: 1,
      sysDomain: "managed-agents",
      isSystemDomainEnabled: true,
      customDomain: "",
      isCustomDomainEnabled: true,
      visibilitySettings: { type: "PUBLIC" },
      isMockData: false,
      ...overrides,
    },
  };
}

test("accepts the published Apifox system domain", () => {
  assert.equal(
    verifyDocumentationSite(site(), {
      projectId: "456",
      siteId: "123",
      url: "https://managed-agents.apifox.cn/",
    }),
    "https://managed-agents.apifox.cn/",
  );
});

test("rejects an unrelated reachable URL", () => {
  assert.throws(
    () =>
      verifyDocumentationSite(site(), {
        projectId: "456",
        siteId: "123",
        url: "https://example.com/",
      }),
    /does not belong/i,
  );
});

test("rejects a mismatched site or project identity", () => {
  assert.throws(
    () =>
      verifyDocumentationSite(site(), {
        projectId: "999",
        siteId: "123",
        url: "https://managed-agents.apifox.cn/",
      }),
    /identity does not match/i,
  );
  assert.throws(
    () =>
      verifyDocumentationSite(site(), {
        projectId: "456",
        siteId: "999",
        url: "https://managed-agents.apifox.cn/",
      }),
    /identity does not match/i,
  );
});

test("rejects private and unpublished documentation sites", () => {
  assert.throws(
    () =>
      verifyDocumentationSite(site({ isPrivate: true }), {
        projectId: "456",
        siteId: "123",
        url: "https://managed-agents.apifox.cn/",
      }),
    /not publicly visible/i,
  );
  assert.throws(
    () =>
      verifyDocumentationSite(site({ visibilitySettings: undefined }), {
        projectId: "456",
        siteId: "123",
        url: "https://managed-agents.apifox.cn/",
      }),
    /not publicly visible/i,
  );
  assert.throws(
    () =>
      verifyDocumentationSite(site({ status: 0 }), {
        projectId: "456",
        siteId: "123",
        url: "https://managed-agents.apifox.cn/",
      }),
    /not published/i,
  );
  assert.throws(
    () =>
      verifyDocumentationSite(site({ isMockData: true }), {
        projectId: "456",
        siteId: "123",
        url: "https://managed-agents.apifox.cn/",
      }),
    /authoritative documentation site/i,
  );
  assert.throws(
    () =>
      verifyDocumentationSite(
        site({ sysDomain: "" }),
        {
          projectId: "456",
          siteId: "123",
          url: "https://managed-agents.apifox.cn/",
        },
      ),
    /no enabled system domain/i,
  );
  assert.throws(
    () =>
      verifyDocumentationSite(
        site({ isSystemDomainEnabled: false }),
        {
          projectId: "456",
          siteId: "123",
          url: "https://managed-agents.apifox.cn/",
        },
      ),
    /no enabled system domain/i,
  );
});

test("rejects non-HTTPS documentation URLs", () => {
  assert.throws(
    () =>
      verifyDocumentationSite(site(), {
        projectId: "456",
        siteId: "123",
        url: "http://managed-agents.apifox.cn/",
      }),
    /must use HTTPS/i,
  );
  assert.throws(
    () =>
      verifyDocumentationSite(site(), {
        projectId: "456",
        siteId: "123",
        url: "https://user:password@managed-agents.apifox.cn/",
      }),
    /must not contain embedded credentials/i,
  );
  assert.throws(
    () =>
      verifyDocumentationSite(site(), {
        projectId: "456",
        siteId: "123",
        url: "https://managed-agents.apifox.cn:8443/",
      }),
    /default HTTPS port/i,
  );
});

test("requires the exact documentation site origin", () => {
  for (const url of [
    "https://managed-agents.apifox.cn/reference",
    "https://managed-agents.apifox.cn/?version=latest",
    "https://managed-agents.apifox.cn/#overview",
  ]) {
    assert.throws(
      () =>
        verifyDocumentationSite(site(), {
          projectId: "456",
          siteId: "123",
          url,
        }),
      /site origin/i,
    );
  }
});

test("rejects unsafe domains returned by Apifox", () => {
  for (const sysDomain of [
    "http://managed-agents.apifox.cn",
    "https://managed-agents.apifox.cn:8443",
    "https://user:secret@managed-agents.apifox.cn",
    "https://managed-agents.apifox.cn/reference",
  ]) {
    assert.throws(
      () =>
        verifyDocumentationSite(site({ sysDomain }), {
          projectId: "456",
          siteId: "123",
          url: "https://managed-agents.apifox.cn/",
        }),
      /unsafe documentation domain/i,
    );
  }
  assert.throws(
    () =>
      verifyDocumentationSite(site({ sysDomain: "docs.company.com" }), {
        projectId: "456",
        siteId: "123",
        url: "https://docs.company.com/",
      }),
    /Apifox system domain/i,
  );
});
