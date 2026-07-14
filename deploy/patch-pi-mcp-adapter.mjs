#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_VERSION = "2.11.0";
const EXPECTED_CONFIG_SHA256 =
  "93f0838946245eba48acb0c77c4afadeaef06efb43e73b550f298a98df5204a3";
const EXPECTED_INDEX_SHA256 =
  "5f5cd23442391ed7d414edc61bdb815cc5e38dbe1741ee51604eeca1cc22fd7b";

function replaceExactlyOnce(source, needle, replacement, label) {
  const first = source.indexOf(needle);
  const last = source.lastIndexOf(needle);
  if (first < 0 || first !== last) {
    throw new Error(
      `Unable to patch pi-mcp-adapter ${EXPECTED_VERSION}: ` +
        `${label} anchor count was ${first < 0 ? 0 : "more than one"}`,
    );
  }
  return source.slice(0, first) + replacement + source.slice(first + needle.length);
}

/**
 * Make the public override path an exclusive configuration boundary. The
 * managed Host always provides this path; ambient global/project config and
 * imports must not add capabilities to it.
 */
export function patchConfigSource(input) {
  const anchor =
    "export function loadMcpConfig(overridePath?: string, cwd = process.cwd()): McpConfig {\n" +
    "  let config: McpConfig = { mcpServers: {} };";
  const replacement =
    "export function loadMcpConfig(overridePath?: string, cwd = process.cwd()): McpConfig {\n" +
    "  if (overridePath) {\n" +
    "    const loaded = readValidatedConfig(\n" +
    "      resolve(overridePath),\n" +
    "      `MCP config override from ${resolve(overridePath)}`,\n" +
    "    );\n" +
    "    if (!loaded) return { mcpServers: {} };\n" +
    "\n" +
    "    // imports are deliberately discarded: a managed override is exclusive.\n" +
    "    return loaded.settings\n" +
    "      ? { mcpServers: loaded.mcpServers, settings: loaded.settings }\n" +
    "      : { mcpServers: loaded.mcpServers };\n" +
    "  }\n" +
    "\n" +
    "  let config: McpConfig = { mcpServers: {} };";
  return replaceExactlyOnce(input, anchor, replacement, "loadMcpConfig");
}

/**
 * Extension registration happens before the per-Turn flag is populated. Keep
 * that early phase capability-free so cached ambient config cannot register
 * direct tools; session_start later loads the explicit managed override.
 */
export function patchIndexSource(input) {
  let source = input;
  source = replaceExactlyOnce(
    source,
    'import type { McpExtensionState } from "./state.ts";',
    'import type { McpExtensionState } from "./state.ts";\n' +
      'import type { McpConfig } from "./types.ts";',
    "McpConfig type import",
  );
  source = replaceExactlyOnce(
    source,
    'import { loadMcpConfig } from "./config.ts";\n',
    "",
    "loadMcpConfig import",
  );
  source = replaceExactlyOnce(
    source,
    'import { getConfigPathFromArgv, normalizeDirectToolInputSchema, truncateAtWord } from "./utils.ts";',
    'import { normalizeDirectToolInputSchema, truncateAtWord } from "./utils.ts";',
    "argv config import",
  );
  source = replaceExactlyOnce(
    source,
    "  const earlyConfigPath = getConfigPathFromArgv();\n" +
      "  const earlyConfig = loadMcpConfig(earlyConfigPath);",
    "  // Managed config is injected only at session_start via the mcp-config flag.\n" +
      "  const earlyConfigPath: string | undefined = undefined;\n" +
      "  const earlyConfig: McpConfig = { mcpServers: {} };",
    "early config",
  );
  return source;
}

function sha256(source) {
  return createHash("sha256").update(source).digest("hex");
}

export function patchPackage(packageRoot) {
  const manifestPath = resolve(packageRoot, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.name !== "pi-mcp-adapter" || manifest.version !== EXPECTED_VERSION) {
    throw new Error(
      `Expected pi-mcp-adapter@${EXPECTED_VERSION}, got ` +
        `${String(manifest.name)}@${String(manifest.version)}`,
    );
  }

  const configPath = resolve(packageRoot, "config.ts");
  const indexPath = resolve(packageRoot, "index.ts");
  const configSource = readFileSync(configPath, "utf8");
  const indexSource = readFileSync(indexPath, "utf8");
  const configHash = sha256(configSource);
  const indexHash = sha256(indexSource);

  if (configHash !== EXPECTED_CONFIG_SHA256) {
    throw new Error(
      `Expected pristine config.ts SHA-256 ${EXPECTED_CONFIG_SHA256}, got ${configHash}`,
    );
  }
  if (indexHash !== EXPECTED_INDEX_SHA256) {
    throw new Error(
      `Expected pristine index.ts SHA-256 ${EXPECTED_INDEX_SHA256}, got ${indexHash}`,
    );
  }

  const patchedConfig = patchConfigSource(configSource);
  const patchedIndex = patchIndexSource(indexSource);
  writeFileSync(configPath, patchedConfig, "utf8");
  writeFileSync(indexPath, patchedIndex, "utf8");
}

function main() {
  const packageRoot = process.argv[2];
  if (!packageRoot) {
    throw new Error("Usage: patch-pi-mcp-adapter.mjs <package-root>");
  }
  patchPackage(packageRoot);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  main();
}
