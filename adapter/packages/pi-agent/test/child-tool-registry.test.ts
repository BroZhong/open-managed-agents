import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterInput, SessionEvent } from "@open-managed-agents/adapter-core";
import { createLocalToolExecutor } from "@open-managed-agents/adapter-tool-executor-local";

const registry = vi.hoisted(() => ({ all: [] as string[], active: [] as string[] }));
vi.mock("@earendil-works/pi-coding-agent", async importOriginal => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...actual,
    async createAgentSession(options: Parameters<typeof actual.createAgentSession>[0]) {
      // Construct the real SDK registry and bind real extensions. Replace only
      // the network prompt so the boundary is tested without a provider call.
      const result = await actual.createAgentSession(options);
      result.session.prompt = async () => {
        registry.all = result.session.getAllTools().map(tool => tool.name).sort();
        registry.active = result.session.getActiveToolNames().sort();
      };
      return result;
    },
  };
});
import { PiAgentAdapter } from "../src/pi-agent-adapter.js";

const sandboxTools = ["bash", "edit", "find", "grep", "ls", "read", "write"];
const delegationTools = ["Agent", "get_subagent_result", "steer_subagent"];
const dirs: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

async function run(isChild: boolean, ambient = false) {
  const agentDir = await mkdtemp(join(tmpdir(), "oma-tool-registry-")); dirs.push(agentDir);
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  if (ambient) {
    await mkdir(join(agentDir, "extensions"));
    await writeFile(join(agentDir, "extensions", "ambient.ts"), `export default function(pi) { for (const name of ['subagent', 'web_search', 'mcp']) pi.registerTool({ name, label: name, description: name, parameters: { type: 'object', properties: {} }, execute: async () => ({content: [{type: 'text', text: 'ambient'}]}) }); }`);
  }
  const { executor, dispose } = await createLocalToolExecutor();
  const host = { delegate: vi.fn(async () => ({})), getResult: vi.fn(async () => ({})), steer: vi.fn(async () => ({})) };
  const input: AdapterInput = { sessionId: "registry", turnId: "turn", history: [], message: { role: "user", content: [{ type: "text", text: "task" }] }, agent: { model: "claude-sonnet-4-5", system: "Registry boundary test instructions." }, toolExecutor: executor, ...(isChild ? { execution: { isChild: true } } : { subagents: host }) };
  const events: SessionEvent[] = [];
  try { for await (const event of new PiAgentAdapter().run(input)) events.push(event); }
  finally { await dispose(); }
  expect(events.filter(event => event.type === "session.error")).toEqual([]);
  return host;
}

describe("actual Pi SDK tool registry for managed children", () => {
  it("registers only seven Sandbox tools for a child, excluding all delegation tools", async () => {
    await run(true);
    expect(registry.all).toEqual(sandboxTools);
    expect(registry.active).toEqual(sandboxTools);
  });
  it("does not load ambient nested-subagent, Web, or MCP registrations into a child", async () => {
    await run(true, true);
    expect(registry.all).toEqual(sandboxTools);
    expect(registry.active).toEqual(sandboxTools);
  });
  it("loads the ambient fixture for a parent so the child exclusion test cannot pass vacuously", async () => {
    await run(false, true);
    expect(registry.all).toEqual([...sandboxTools, ...delegationTools, "subagent", "web_search", "mcp"].sort());
  });
  it("registers the three Host delegation tools only for the parent", async () => {
    const host = await run(false);
    expect(registry.all).toEqual([...sandboxTools, ...delegationTools].sort());
    expect(registry.active).toEqual([...sandboxTools, ...delegationTools].sort());
    expect(host.delegate).not.toHaveBeenCalled();
  });
});
