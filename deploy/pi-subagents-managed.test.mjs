import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const root = new URL("../", import.meta.url);
test("the server image uses Host-owned delegation without a plugin installation or overlay", () => {
  const dockerfile = readFileSync(new URL("deploy/Dockerfile.server", root), "utf8");
  assert.doesNotMatch(dockerfile, /pi-subagents|storyboard-stage|subagents\.json/);
  assert.match(dockerfile, /pi-mcp-adapter/);
  assert.match(dockerfile, /pi-web-access/);
});
