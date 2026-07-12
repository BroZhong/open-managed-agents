import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("the tintinweb extension exposes only the managed text-only Agent type", () => {
  const settings = JSON.parse(
    readFileSync(new URL("deploy/pi-subagents-settings.json", root), "utf8"),
  );
  const agent = readFileSync(
    new URL("deploy/pi-subagents-storyboard-stage.md", root),
    "utf8",
  );

  assert.equal(settings.disableDefaultAgents, true);
  assert.equal(settings.schedulingEnabled, false);
  assert.equal(settings.toolDescriptionMode, "compact");
  assert.match(agent, /^---\n[\s\S]*\ntools: none\n/m);
  assert.match(agent, /^extensions: false$/m);
  assert.match(agent, /^skills: false$/m);
  assert.match(agent, /^isolated: true$/m);
  assert.match(agent, /^run_in_background: false$/m);
});

test("the server image installs the requested package and no binary wrapper", () => {
  const dockerfile = readFileSync(
    new URL("deploy/Dockerfile.server", root),
    "utf8",
  );

  assert.match(
    dockerfile,
    /pi install[\s\S]*npm:\@tintinweb\/pi-subagents@\$\{PI_SUBAGENTS_VERSION\}/,
  );
  assert.match(dockerfile, /COPY deploy\/pi-subagents-settings\.json/);
  assert.match(dockerfile, /COPY deploy\/pi-subagents-storyboard-stage\.md/);
  assert.doesNotMatch(dockerfile, /PI_SUBAGENT_PI_BINARY/);
  assert.doesNotMatch(dockerfile, /pi-subagent-safe\.mjs/);
});
