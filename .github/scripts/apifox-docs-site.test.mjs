import test from "node:test";
import assert from "node:assert/strict";
import { verifyDocumentationSite } from "./apifox-docs-site.mjs";

function site(overrides = {}) {
  return {
    success: true,
    data: {
      id: 123,
      projectId: 456,
      isPrivate: false,
      sysDomain: "managed-agents.apifox.cn",
      customDomain: "",
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

test("accepts a configured custom domain", () => {
  assert.equal(
    verifyDocumentationSite(
      site({ customDomain: "https://docs.example.com", sysDomain: "" }),
      {
        projectId: "456",
        siteId: "123",
        url: "https://docs.example.com/reference",
      },
    ),
    "https://docs.example.com/reference",
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
      verifyDocumentationSite(
        site({ sysDomain: "", customDomain: "", domainName: "" }),
        {
          projectId: "456",
          siteId: "123",
          url: "https://managed-agents.apifox.cn/",
        },
      ),
    /no published.*domain/i,
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
});
