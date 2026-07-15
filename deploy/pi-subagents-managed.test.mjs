import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  assertPinnedForegroundPrecedence,
  patchAgentRunnerSource,
} from "./patch-tintinweb-pi-subagents.mjs";

const root = new URL("../", import.meta.url);

test("the tintinweb extension exposes only the managed Sandbox-backed Agent type", () => {
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
  assert.equal(settings.defaultMaxTurns, 30);
  assert.match(agent, /^---\n[\s\S]*\ntools: "\*"\n/m);
  assert.match(agent, /^extensions: false$/m);
  assert.match(agent, /^skills: false$/m);
  assert.match(agent, /^isolated: true$/m);
  assert.match(agent, /^run_in_background: false$/m);
  assert.match(agent, /^prompt_mode: append$/m);
  assert.match(agent, /^max_turns: 30$/m);
  assert.match(agent, /Treat `\/home\/user` as the only Workspace root/);
  assert.match(agent, /Equipped Skills are\s+projected under `\/skills\/`/);
  assert.doesNotMatch(agent, /Treat `\/workspace` as the only Workspace root/);
});

test("the server image installs and patches the requested package", () => {
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
  assert.match(dockerfile, /patch-tintinweb-pi-subagents\.mjs/);
  assert.doesNotMatch(dockerfile, /pi-tasks|TaskExecute/i);
});

test("the managed Agent remains foreground even when the tool requests background execution", () => {
  const pinnedPrecedence =
    "runInBackground: agentConfig?.runInBackground ?? params.run_in_background ?? false,";
  assert.doesNotThrow(() =>
    assertPinnedForegroundPrecedence(pinnedPrecedence),
  );
  assert.throws(
    () =>
      assertPinnedForegroundPrecedence(
        "runInBackground: params.run_in_background ?? agentConfig?.runInBackground ?? false,",
      ),
    /frontmatter.*precedence/i,
  );

  const managedAgentRunInBackground = false;
  const explicitToolParameter = true;
  assert.equal(
    managedAgentRunInBackground ?? explicitToolParameter ?? false,
    false,
  );
});

test("the pinned package patch injects managed tools and persistent child usage", () => {
  const source = `
import type { ExtensionContext, LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
const EXCLUDED_TOOL_NAMES: string[] = Object.values(SUBAGENT_TOOL_NAMES);
  const builtinToolNameSet = new Set(toolNames);
  const allowedTools = [...toolNames, ...extensionToolNames].filter((t) => {
    if (EXCLUDED_TOOL_NAMES.includes(t)) return false;
    if (disallowedSet?.has(t)) return false;
    if (builtinToolNameSet.has(t)) return true;
    return !noExtensions;
  });
  const sessionOpts: Parameters<typeof createAgentSession>[0] = {
    cwd: effectiveCwd,
    model,
    tools: allowedTools,
    resourceLoader: loader,
  };
  const { session } = await createAgentSession(sessionOpts);

  const baseSessionName = agentConfig?.name ?? type;

export async function resumeAgent(session: AgentSession, prompt: string) {
  await session.prompt(prompt);
}
`;

  const patched = patchAgentRunnerSource(source);

  assert.match(patched, /await lookupManagedCustomTools\(options\.pi\)/);
  assert.match(patched, /oma:sandbox-tools:v1:get/);
  assert.match(patched, /missingManagedToolNames/);
  assert.match(patched, /BUILTIN_TOOL_NAMES\.filter/);
  assert.match(patched, /customTools: managedCustomTools/);
  assert.match(patched, /noTools: "builtin"/);
  assert.match(
    patched,
    /await lookupManagedCustomTools\(options\.pi\)[\s\S]*?const \{ session \} = await createAgentSession\(sessionOpts\)/,
  );
  assert.match(patched, /oma:subagent-usage:v1/);
  assert.match(
    patched,
    /publishManagedSubagentUsage\(options\.pi, options\.agentId, u\)/,
  );
  assert.match(patched, /cacheRead: u\.cacheRead \?\? 0/);
  assert.match(patched, /cacheWrite: u\.cacheWrite \?\? 0/);
  assert.equal(
    [...patched.matchAll(/publishManagedSubagentUsage\(options\.pi, options\.agentId, u\)/g)].length,
    1,
  );
  assert.match(
    patched,
    /const \{ session \} = await createAgentSession\(sessionOpts\);[\s\S]*?session\.subscribe\([\s\S]*?publishManagedSubagentUsage\(options\.pi, options\.agentId, u\)[\s\S]*?const baseSessionName/,
  );
  assert.match(
    patched,
    /export async function resumeAgent\(session: AgentSession, prompt: string\)[\s\S]*?await session\.prompt\(prompt\)/,
  );
});
