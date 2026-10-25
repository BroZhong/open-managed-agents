import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("database migrations have unique ordered prefixes", () => {
  const files = readdirSync(new URL("deploy/migrations/", root)).filter((name) => name.endsWith(".sql"));
  // A rollback sits next to the migration it undoes: <migration>.rollback.sql.
  const rollbacks = files.filter((name) => name.endsWith(".rollback.sql"));
  const names = files.filter((name) => !rollbacks.includes(name)).sort();
  const prefixes = names.map((name) => {
    const match = /^(\d{4})_[a-z0-9_]+\.sql$/.exec(name);
    assert.ok(match, `migration filename is not canonical: ${name}`);
    return match[1];
  });

  assert.equal(new Set(prefixes).size, prefixes.length, `duplicate migration prefix: ${names.join(", ")}`);
  for (const rollback of rollbacks) {
    assert.ok(names.includes(rollback.replace(/\.rollback\.sql$/, ".sql")), `rollback without its migration: ${rollback}`);
  }
});

test("the public API prefix bypasses the Web SPA fallback", () => {
  const dockerfile = readFileSync(new URL("deploy/Dockerfile.web", root), "utf8");
  const manifest = readFileSync(new URL("deploy/k8s.yaml", root), "utf8");

  assert.doesNotMatch(dockerfile, /proxy_pass/);
  assert.match(
    manifest,
    /path: \/api\s+pathType: Prefix\s+backend:\s+service:\s+name: oma-server\s+port:\s+number: 3000/,
  );
  assert.match(manifest, /PUBLIC_API_URL: "https:\/\/agentry\.welltop\.tech\/api"/);
  assert.match(manifest, /API_BASE_PATH: "\/api"/);
});
