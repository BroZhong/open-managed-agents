import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  patchConfigSource,
  patchIndexSource,
  patchPackage,
} from "./patch-pi-mcp-adapter.mjs";

const root = new URL("../", import.meta.url);
const pristinePackage = "/tmp/pi-mcp-adapter-2.11-review/package";

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

test("the overlay is pinned to the reviewed package and rejects changed anchors", () => {
  const source = readFileSync(
    new URL("deploy/patch-pi-mcp-adapter.mjs", root),
    "utf8",
  );

  assert.match(source, /const EXPECTED_VERSION = "2\.11\.0"/);
  assert.match(
    source,
    /93f0838946245eba48acb0c77c4afadeaef06efb43e73b550f298a98df5204a3/,
  );
  assert.match(
    source,
    /5f5cd23442391ed7d414edc61bdb815cc5e38dbe1741ee51604eeca1cc22fd7b/,
  );

  const configAnchor =
    "export function loadMcpConfig(overridePath?: string, cwd = process.cwd()): McpConfig {\n" +
    "  let config: McpConfig = { mcpServers: {} };";
  const patchedConfig = patchConfigSource(configAnchor);
  assert.match(patchedConfig, /if \(overridePath\)/);
  assert.match(
    patchedConfig,
    /readValidatedConfig\(\s*resolve\(overridePath\)/,
  );
  assert.match(patchedConfig, /imports are deliberately discarded/);
  assert.throws(
    () => patchConfigSource("export function unrelated() {}"),
    /loadMcpConfig anchor count was 0/,
  );
  assert.throws(
    () => patchConfigSource(`${configAnchor}\n${configAnchor}`),
    /loadMcpConfig anchor count was more than one/,
  );

  const indexSource = `
import type { McpExtensionState } from "./state.ts";
import { loadMcpConfig } from "./config.ts";
import { getConfigPathFromArgv, normalizeDirectToolInputSchema, truncateAtWord } from "./utils.ts";
  const earlyConfigPath = getConfigPathFromArgv();
  const earlyConfig = loadMcpConfig(earlyConfigPath);
`;
  const patchedIndex = patchIndexSource(indexSource);
  assert.match(patchedIndex, /const earlyConfig: McpConfig = \{ mcpServers: \{\} \}/);
  assert.doesNotMatch(patchedIndex, /getConfigPathFromArgv/);
  assert.doesNotMatch(patchedIndex, /loadMcpConfig/);
  assert.throws(
    () => patchIndexSource(indexSource.replace("  const earlyConfigPath", "  const renamedPath")),
    /early config anchor count was 0/,
  );
});

test("the server image applies the MCP overlay immediately after installing the pin", () => {
  const dockerfile = readFileSync(
    new URL("deploy/Dockerfile.server", root),
    "utf8",
  );

  assert.match(
    dockerfile,
    /COPY deploy\/patch-pi-mcp-adapter\.mjs \/tmp\/patch-pi-mcp-adapter\.mjs/,
  );
  assert.match(
    dockerfile,
    /npm:pi-mcp-adapter@\$\{PI_MCP_ADAPTER_VERSION\}[\s\S]*?node \/tmp\/patch-pi-mcp-adapter\.mjs \\\n+      \/opt\/pi-agent-seed\/npm\/node_modules\/pi-mcp-adapter[\s\S]*?npm:\@tintinweb\/pi-subagents@\$\{PI_SUBAGENTS_VERSION\}/,
  );
});

test("a managed override excludes ambient and imported MCP servers", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "oma-pi-mcp-behavior-"));
  const home = join(tempRoot, "home");
  const cwd = join(tempRoot, "workspace");
  const overridePath = join(tempRoot, "managed-mcp.json");
  const modulePath = join(tempRoot, "synthetic-config.ts");
  const originalHome = process.env.HOME;
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

  try {
    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = join(home, ".pi", "agent");
    writeJson(join(home, ".config", "mcp", "mcp.json"), {
      mcpServers: { "ambient-global": { command: "malicious-global" } },
    });
    writeJson(join(home, ".pi", "agent", "mcp.json"), {
      mcpServers: { "ambient-pi": { command: "malicious-pi" } },
    });
    writeJson(join(cwd, ".mcp.json"), {
      mcpServers: { "ambient-project": { command: "malicious-project" } },
    });
    writeJson(join(cwd, ".pi", "mcp.json"), {
      mcpServers: { "ambient-project-pi": { command: "malicious-project-pi" } },
    });
    writeJson(join(home, ".claude", "mcp.json"), {
      mcpServers: { "ambient-import": { command: "malicious-import" } },
    });
    writeJson(overridePath, {
      mcpServers: { managed: { command: "safe-managed-command" } },
      imports: ["claude-code"],
      settings: { toolPrefix: "short" },
    });

    const upstreamLikeSource = `
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

type McpConfig = {
  mcpServers: Record<string, Record<string, unknown>>;
  imports?: string[];
  settings?: Record<string, unknown>;
};

function readValidatedConfig(path: string, _label: string): McpConfig | null {
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return {
    mcpServers: raw.mcpServers ?? {},
    imports: Array.isArray(raw.imports) ? raw.imports : undefined,
    settings: raw.settings,
  };
}

function getConfigSources(overridePath?: string, cwd = process.cwd()) {
  return [
    join(homedir(), ".config", "mcp", "mcp.json"),
    join(homedir(), ".pi", "agent", "mcp.json"),
    overridePath ? resolve(overridePath) : join(homedir(), ".pi", "agent", "mcp.json"),
    resolve(cwd, ".mcp.json"),
    resolve(cwd, ".pi", "mcp.json"),
  ].map((readPath) => ({ readPath }));
}

function expandImports(config: McpConfig): McpConfig {
  if (!config.imports?.includes("claude-code")) return config;
  const imported = readValidatedConfig(
    join(homedir(), ".claude", "mcp.json"),
    "ambient import",
  );
  return imported
    ? { ...config, mcpServers: { ...imported.mcpServers, ...config.mcpServers } }
    : config;
}

function mergeConfigs(base: McpConfig, next: McpConfig): McpConfig {
  return {
    mcpServers: { ...base.mcpServers, ...next.mcpServers },
    imports: next.imports ?? base.imports,
    settings: next.settings ?? base.settings,
  };
}

export function loadMcpConfig(overridePath?: string, cwd = process.cwd()): McpConfig {
  let config: McpConfig = { mcpServers: {} };
  for (const source of getConfigSources(overridePath, cwd)) {
    const loaded = readValidatedConfig(source.readPath, source.readPath);
    if (loaded) config = mergeConfigs(config, expandImports(loaded));
  }
  return config;
}
`;
    writeFileSync(modulePath, patchConfigSource(upstreamLikeSource), "utf8");

    const moduleUrl = `${pathToFileURL(modulePath).href}?test=${Date.now()}`;
    const { loadMcpConfig } = await import(moduleUrl);
    const config = loadMcpConfig(overridePath, cwd);

    assert.deepEqual(config, {
      mcpServers: { managed: { command: "safe-managed-command" } },
      settings: { toolPrefix: "short" },
    });
    assert.equal(config.imports, undefined);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test(
  "the reviewed 2.11.0 package loads only the managed override after patching",
  { skip: !existsSync(pristinePackage) },
  async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "oma-pi-mcp-overlay-"));
    const packageRoot = join(tempRoot, "package");
    const home = join(tempRoot, "home");
    const cwd = join(tempRoot, "workspace");
    const overridePath = join(tempRoot, "managed-mcp.json");
    const originalHome = process.env.HOME;
    const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

    try {
      cpSync(pristinePackage, packageRoot, { recursive: true });
      patchPackage(packageRoot);

      const patchedConfig = readFileSync(join(packageRoot, "config.ts"), "utf8");
      const patchedIndex = readFileSync(join(packageRoot, "index.ts"), "utf8");
      assert.match(patchedConfig, /if \(overridePath\)/);
      assert.doesNotMatch(patchedIndex, /getConfigPathFromArgv/);
      assert.match(patchedIndex, /const earlyConfig: McpConfig = \{ mcpServers: \{\} \}/);

      const tamperedRoot = join(tempRoot, "tampered");
      cpSync(pristinePackage, tamperedRoot, { recursive: true });
      writeFileSync(
        join(tamperedRoot, "config.ts"),
        `${readFileSync(join(tamperedRoot, "config.ts"), "utf8")}\n// changed\n`,
        "utf8",
      );
      assert.throws(() => patchPackage(tamperedRoot), /pristine config\.ts SHA-256/);

      process.env.HOME = home;
      process.env.PI_CODING_AGENT_DIR = join(home, ".pi", "agent");
      writeJson(join(home, ".config", "mcp", "mcp.json"), {
        mcpServers: { "ambient-global": { command: "malicious-global" } },
      });
      writeJson(join(home, ".pi", "agent", "mcp.json"), {
        mcpServers: { "ambient-pi": { command: "malicious-pi" } },
      });
      writeJson(join(cwd, ".mcp.json"), {
        mcpServers: { "ambient-project": { command: "malicious-project" } },
      });
      writeJson(join(cwd, ".pi", "mcp.json"), {
        mcpServers: { "ambient-project-pi": { command: "malicious-project-pi" } },
      });
      writeJson(join(home, ".claude", "mcp.json"), {
        mcpServers: { "ambient-import": { command: "malicious-import" } },
      });
      writeJson(overridePath, {
        mcpServers: { managed: { command: "safe-managed-command" } },
        imports: ["claude-code"],
        settings: { toolPrefix: "short" },
      });

      const moduleUrl = `${pathToFileURL(join(packageRoot, "config.ts")).href}?test=${Date.now()}`;
      const { loadMcpConfig } = await import(moduleUrl);
      const config = loadMcpConfig(overridePath, cwd);

      assert.deepEqual(config, {
        mcpServers: { managed: { command: "safe-managed-command" } },
        settings: { toolPrefix: "short" },
      });
      assert.equal(config.imports, undefined);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
      rmSync(tempRoot, { recursive: true, force: true });
    }
  },
);
