import { beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import type {
  AdapterInput,
  SessionEvent,
  ToolExecutor,
} from "@open-managed-agents/adapter-core";

const sdkSeam = vi.hoisted(() => ({
  loadSkillsCalls: 0,
  resourceLoaderOptions: [] as Array<Record<string, unknown>>,
  sessionOptions: [] as Array<{
    cwd?: string;
    sessionManager?: { getCwd(): string };
  }>,
  mcpConfigPath: undefined as string | undefined,
  mcpConfig: undefined as unknown,
  lifecycle: [] as string[],
  failBindExtensions: false,
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();

  class FakeResourceLoader {
    private readonly runtime = { flagValues: new Map<string, boolean | string>() };

    constructor(options: Record<string, unknown>) {
      sdkSeam.resourceLoaderOptions.push(options);
    }

    async reload(): Promise<void> {}

    getExtensions() {
      return { extensions: [], errors: [], runtime: this.runtime };
    }
  }

  return {
    ...actual,
    DefaultResourceLoader: FakeResourceLoader,
    loadSkills: () => {
      sdkSeam.loadSkillsCalls += 1;
      throw new Error("Host loadSkills must not read sandbox paths");
    },
    createAgentSession: async (options: {
      cwd?: string;
      resourceLoader?: FakeResourceLoader;
      sessionManager?: { getCwd(): string };
    }) => {
      sdkSeam.sessionOptions.push(options);
      const configPath = options.resourceLoader
        ?.getExtensions()
        .runtime.flagValues.get("mcp-config");
      if (typeof configPath === "string") {
        sdkSeam.mcpConfigPath = configPath;
        sdkSeam.mcpConfig = JSON.parse(readFileSync(configPath, "utf8"));
      }
      let listener: ((event: Record<string, unknown>) => void) | undefined;
      return {
        session: {
          async bindExtensions() {
            if (sdkSeam.failBindExtensions) {
              throw new Error("extension startup failed");
            }
            sdkSeam.lifecycle.push("session_start");
          },
          extensionRunner: {
            async emit(event: { type: string }) {
              if (event.type === "session_shutdown") {
                sdkSeam.lifecycle.push("session_shutdown");
              }
            },
          },
          subscribe(next: (event: Record<string, unknown>) => void) {
            listener = next;
            return () => {
              listener = undefined;
            };
          },
          async prompt() {
            listener?.({ type: "agent_end", messages: [], willRetry: false });
          },
          abort() {},
          dispose() {
            sdkSeam.lifecycle.push("dispose");
          },
        },
      };
    },
  };
});

import { PiAgentAdapter } from "../src/pi-agent-adapter.js";

const noopExecutor: ToolExecutor = {
  async *exec() {},
  async readFile() {
    return "";
  },
  async writeFile() {},
  async list() {
    return [];
  },
};

function input(withExecutor: boolean): AdapterInput {
  return {
    sessionId: "resolved-skills",
    turnId: "turn-1",
    message: { role: "user", content: [{ type: "text", text: "use the skill" }] },
    agent: {
      model: "claude-sonnet-4-5",
      system: "BASE",
      skillPaths: ["/skills/skill_abc"],
      skillDescriptors: [
        {
          name: "teach",
          description: "Teach a concept clearly.",
          path: "/skills/skill_abc/SKILL.md",
        },
      ],
    } as AdapterInput["agent"] & {
      skillDescriptors: Array<{ name: string; description: string; path: string }>;
    },
    history: [],
    toolExecutor: withExecutor ? noopExecutor : undefined,
  };
}

async function collect(iterable: AsyncIterable<SessionEvent>): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe("Pi adapter resolved Skill descriptor seam", () => {
  beforeEach(() => {
    sdkSeam.loadSkillsCalls = 0;
    sdkSeam.resourceLoaderOptions.length = 0;
    sdkSeam.sessionOptions.length = 0;
    sdkSeam.mcpConfigPath = undefined;
    sdkSeam.mcpConfig = undefined;
    sdkSeam.lifecycle.length = 0;
    sdkSeam.failBindExtensions = false;
  });

  it("formats sandbox Skill descriptors on the real custom-tool createSession path", async () => {
    const events = await collect(new PiAgentAdapter().run(input(true)));

    expect(events.some((event) => event.type === "session.error")).toBe(false);
    expect(sdkSeam.loadSkillsCalls).toBe(0);
    expect(sdkSeam.resourceLoaderOptions).toHaveLength(1);
    const options = sdkSeam.resourceLoaderOptions[0];
    expect(options.noSkills).toBe(true);
    expect(options.additionalSkillPaths).toBeUndefined();
    expect(options.appendSystemPrompt).toEqual([
      "BASE",
      expect.stringContaining("<available_skills>"),
    ]);
    expect(String((options.appendSystemPrompt as string[])[1])).toContain(
      "/skills/skill_abc/SKILL.md",
    );
    expect(options.cwd).toBe("/home/user");
    expect(sdkSeam.sessionOptions[0].cwd).toBe("/home/user");
    expect(sdkSeam.sessionOptions[0].sessionManager?.getCwd()).toBe("/home/user");
  });

  it("preserves native skillPaths when no ToolExecutor is injected", async () => {
    const events = await collect(new PiAgentAdapter().run(input(false)));

    expect(events.some((event) => event.type === "session.error")).toBe(false);
    expect(sdkSeam.loadSkillsCalls).toBe(0);
    expect(sdkSeam.resourceLoaderOptions[0]).toMatchObject({
      cwd: process.cwd(),
      additionalSkillPaths: ["/skills/skill_abc"],
      noContextFiles: true,
    });
    expect(sdkSeam.sessionOptions[0].cwd).toBe(process.cwd());
    expect(sdkSeam.sessionOptions[0].sessionManager?.getCwd()).toBe(process.cwd());
  });

  it("projects each Agent's MCP servers through an isolated Pi config and removes it after the Turn", async () => {
    const configured = input(true);
    configured.agent.mcpServers = [
      {
        name: "rds-mcp",
        url: "https://campaign.welltop.tech/agent/mcp/rds",
        transport: "streamable-http",
        headers: {
          Authorization: "Bearer ${RDS_MCP_APIKEY}",
        },
      },
    ];

    const events = await collect(new PiAgentAdapter().run(configured));

    expect(events.some((event) => event.type === "session.error")).toBe(false);
    expect(sdkSeam.mcpConfig).toEqual({
      mcpServers: {
        "rds-mcp": {
          url: "https://campaign.welltop.tech/agent/mcp/rds",
          transport: "streamable-http",
          headers: {
            Authorization: "Bearer ${RDS_MCP_APIKEY}",
          },
        },
      },
    });
    expect(sdkSeam.mcpConfigPath).toBeDefined();
    expect(existsSync(sdkSeam.mcpConfigPath!)).toBe(false);
  });

  it("starts and shuts down Pi extension lifecycle around the managed Turn", async () => {
    await collect(new PiAgentAdapter().run(input(true)));

    expect(sdkSeam.lifecycle).toEqual([
      "session_start",
      "session_shutdown",
      "dispose",
    ]);
  });

  it("disposes a partially-created session when extension startup fails", async () => {
    const configured = input(true);
    configured.agent.mcpServers = [
      {
        name: "rds-mcp",
        url: "https://campaign.welltop.tech/agent/mcp/rds",
        transport: "streamable-http",
        headers: { Authorization: "Bearer ${RDS_MCP_APIKEY}" },
      },
    ];
    sdkSeam.failBindExtensions = true;

    const events = await collect(new PiAgentAdapter().run(configured));

    expect(events).toEqual([
      expect.objectContaining({
        type: "session.error",
        error: expect.objectContaining({ message: "extension startup failed" }),
      }),
    ]);
    expect(sdkSeam.lifecycle).toEqual(["dispose"]);
    expect(sdkSeam.mcpConfigPath).toBeDefined();
    expect(existsSync(sdkSeam.mcpConfigPath!)).toBe(false);
  });
});
