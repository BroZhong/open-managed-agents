import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("database migrations have unique ordered prefixes", () => {
  const names = readdirSync(new URL("deploy/migrations/", root))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const prefixes = names.map((name) => {
    const match = /^(\d{4})_[a-z0-9_]+\.sql$/.exec(name);
    assert.ok(match, `migration filename is not canonical: ${name}`);
    return match[1];
  });

  assert.equal(new Set(prefixes).size, prefixes.length, `duplicate migration prefix: ${names.join(", ")}`);
});

test("the public OpenAPI endpoint bypasses the Web SPA fallback", () => {
  const dockerfile = readFileSync(new URL("deploy/Dockerfile.web", root), "utf8");
  const manifest = readFileSync(new URL("deploy/k8s.yaml", root), "utf8");

  assert.doesNotMatch(dockerfile, /proxy_pass/);
  assert.match(
    manifest,
    /path: \/openapi\.json\s+pathType: Exact\s+backend:\s+service:\s+name: oma-server\s+port: \{ number: 3000 \}/,
  );
  assert.match(manifest, /PUBLIC_API_URL: "https:\/\/console\.sandbox\.brozhong\.com"/);
});
