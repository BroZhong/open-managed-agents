#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_VERSION = "0.13.0";
const EXPECTED_RUNNER_SHA256 =
  "d97ab096a2d7f1a41db4963183bdc4ac96ecbc4653d2390989da1a9d4ec23f99";

function replaceExactlyOnce(source, needle, replacement, label) {
  const first = source.indexOf(needle);
  const last = source.lastIndexOf(needle);
  if (first < 0 || first !== last) {
    throw new Error(
      `Unable to patch @tintinweb/pi-subagents ${EXPECTED_VERSION}: ` +
        `${label} anchor count was ${first < 0 ? 0 : "more than one"}`,
    );
  }
  return source.slice(0, first) + replacement + source.slice(first + needle.length);
}

/**
 * Patch the pinned extension at its narrow child-session construction seam.
 * The upstream package has no public customTools provider yet. This overlay is
 * deliberately version/anchor guarded so an upstream source change fails the
 * image build instead of silently restoring Host-native tools.
 */
export function patchAgentRunnerSource(input) {
  let source = input;
  source = replaceExactlyOnce(
    source,
    'import type { ExtensionContext, LoadExtensionsResult } from "@earendil-works/pi-coding-agent";',
    'import type { ExtensionContext, LoadExtensionsResult, ToolDefinition } from "@earendil-works/pi-coding-agent";',
    "ToolDefinition import",
  );
  source = replaceExactlyOnce(
    source,
    "const EXCLUDED_TOOL_NAMES: string[] = Object.values(SUBAGENT_TOOL_NAMES);",
    `const EXCLUDED_TOOL_NAMES: string[] = Object.values(SUBAGENT_TOOL_NAMES);

const MANAGED_SUBAGENT_TOOLS_REQUEST = "oma:sandbox-tools:v1:get";
let managedToolRequestSequence = 0;

async function lookupManagedCustomTools(pi: ExtensionAPI): Promise<ToolDefinition[]> {
  const requestId = \`\${process.pid}-\${++managedToolRequestSequence}\`;
  const replyChannel = \`\${MANAGED_SUBAGENT_TOOLS_REQUEST}:reply:\${requestId}\`;

  return new Promise<ToolDefinition[]>((resolve, reject) => {
    let unsubscribe = () => {};
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(
        "Managed Sandbox tools are unavailable for this parent session; " +
        "refusing to create a subagent with Host-native tools",
      ));
    }, 1000);

    unsubscribe = pi.events.on(replyChannel, (raw) => {
      clearTimeout(timeout);
      unsubscribe();
      const tools = raw && typeof raw === "object"
        ? (raw as { tools?: unknown }).tools
        : undefined;
      if (!Array.isArray(tools) || tools.length === 0) {
        reject(new Error("Managed Sandbox tool bridge returned no tools"));
        return;
      }
      resolve(tools as ToolDefinition[]);
    });

    pi.events.emit(MANAGED_SUBAGENT_TOOLS_REQUEST, { requestId });
  });
}`,
    "managed bridge helper",
  );
  source = replaceExactlyOnce(
    source,
    `  const builtinToolNameSet = new Set(toolNames);
  const allowedTools = [...toolNames, ...extensionToolNames].filter((t) => {`,
    `  const managedCustomTools = await lookupManagedCustomTools(options.pi);
  const managedToolNameSet = new Set(managedCustomTools.map((tool) => tool.name));
  const missingManagedToolNames = BUILTIN_TOOL_NAMES.filter(
    (name) => !managedToolNameSet.has(name),
  );
  if (missingManagedToolNames.length > 0) {
    throw new Error(
      \`Missing managed Sandbox tools for subagent: \${missingManagedToolNames.join(", ")}\`,
    );
  }
  const builtinToolNameSet = new Set(toolNames);
  const allowedTools = [...toolNames, ...extensionToolNames].filter((t) => {`,
    "managed tool allowlist",
  );
  source = replaceExactlyOnce(
    source,
    `    model,
    tools: allowedTools,
    resourceLoader: loader,`,
    `    model,
    tools: allowedTools,
    noTools: "builtin",
    customTools: managedCustomTools,
    resourceLoader: loader,`,
    "child createAgentSession options",
  );
  return source;
}

function main() {
  const packageRoot = process.argv[2];
  if (!packageRoot) {
    throw new Error("Usage: patch-tintinweb-pi-subagents.mjs <package-root>");
  }

  const manifestPath = resolve(packageRoot, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.name !== "@tintinweb/pi-subagents" || manifest.version !== EXPECTED_VERSION) {
    throw new Error(
      `Expected @tintinweb/pi-subagents@${EXPECTED_VERSION}, got ` +
        `${String(manifest.name)}@${String(manifest.version)}`,
    );
  }

  const runnerPath = resolve(packageRoot, "src/agent-runner.ts");
  const original = readFileSync(runnerPath, "utf8");
  const actualHash = createHash("sha256").update(original).digest("hex");
  if (actualHash !== EXPECTED_RUNNER_SHA256) {
    throw new Error(
      `Expected pristine agent-runner SHA-256 ${EXPECTED_RUNNER_SHA256}, got ${actualHash}`,
    );
  }
  const patched = patchAgentRunnerSource(original);
  writeFileSync(runnerPath, patched, "utf8");
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  main();
}
