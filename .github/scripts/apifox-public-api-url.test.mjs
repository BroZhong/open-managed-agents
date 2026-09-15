import test from "node:test";
import assert from "node:assert/strict";
import { normalizePublicApiUrl } from "./apifox-public-api-url.mjs";

test("accepts a public HTTPS origin and normalizes its trailing slash", () => {
  assert.equal(
    normalizePublicApiUrl("https://api.example.com/"),
    "https://api.example.com",
  );
  assert.equal(
    normalizePublicApiUrl("https://1.1.1.1:8443"),
    "https://1.1.1.1:8443",
  );
  for (const value of [
    "https://192.0.0.9",
    "https://192.0.0.10",
    "https://192.0.1.1",
    "https://192.0.3.1",
  ]) {
    assert.equal(normalizePublicApiUrl(value), value);
  }
});

test("allows PUBLIC_API_URL to be omitted for documentation-only publishing", () => {
  assert.equal(normalizePublicApiUrl(undefined), null);
  assert.equal(normalizePublicApiUrl("  "), null);
});

test("preserves API path prefixes while normalizing trailing slashes", () => {
  for (const [input, expected] of [
    ["https://agentry.welltop.tech/api", "https://agentry.welltop.tech/api"],
    [" https://agentry.welltop.tech/api/ ", "https://agentry.welltop.tech/api"],
    ["https://api.example.com/api/v1///", "https://api.example.com/api/v1"],
    ["https://api.example.com:8443/api", "https://api.example.com:8443/api"],
  ]) {
    assert.equal(normalizePublicApiUrl(input), expected);
  }
});

test("rejects non-HTTPS and embedded credentials", () => {
  assert.throws(
    () => normalizePublicApiUrl("http://api.example.com"),
    /must use HTTPS/i,
  );
  assert.throws(
    () => normalizePublicApiUrl("https://user:secret@api.example.com"),
    /embedded credentials/i,
  );
});

test("rejects OpenAPI document URLs as API bases", () => {
  for (const path of [
    "/openapi.json",
    "/api/openapi.json/",
    "/api/%6fpenapi.json",
  ]) {
    assert.throws(
      () => normalizePublicApiUrl(`https://api.example.com${path}`),
      /not an OpenAPI document URL/i,
    );
  }
});

test("rejects malformed paths, query strings, and fragments", () => {
  assert.throws(
    () => normalizePublicApiUrl("https://api.example.com/api/%"),
    /valid URL path/i,
  );
  assert.throws(
    () => normalizePublicApiUrl("https://api.example.com/api?environment=test"),
    /query string or fragment/i,
  );
  assert.throws(
    () => normalizePublicApiUrl("https://api.example.com/api#docs"),
    /query string or fragment/i,
  );
});

test("rejects local and private network targets", () => {
  for (const value of [
    "https://localhost:3000",
    "https://localhost.",
    "https://foo.localhost.",
    "https://api.internal",
    "https://api.home.arpa",
    "https://10.0.0.1",
    "https://172.16.0.1",
    "https://192.168.1.1",
    "https://127.0.0.1",
    "https://203.0.113.10",
    "https://[::1]",
    "https://[fd00::1]",
    "https://[::ffff:10.0.0.1]",
    "https://[::ffff:127.0.0.1]",
  ]) {
    assert.throws(() => normalizePublicApiUrl(value), /public|private|reserved/i);
    assert.throws(
      () => normalizePublicApiUrl(`${value}/api`),
      /public|private|reserved/i,
    );
  }
});
