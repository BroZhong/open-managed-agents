import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AdapterInput,
  SessionEvent,
  ToolExecutor,
} from "@open-managed-agents/adapter-core";

const sdkSeam = vi.hoisted(() => ({
  loadSkillsCalls: 0,
  resourceLoaderOptions: [] as Array<Record<string, unknown>>,
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();

  class FakeResourceLoader {
    constructor(options: Record<string, unknown>) {
      sdkSeam.resourceLoaderOptions.push(options);
    }

    async reload(): Promise<void> {}
  }

  return {
    ...actual,
    DefaultResourceLoader: FakeResourceLoader,
    loadSkills: () => {
      sdkSeam.loadSkillsCalls += 1;
      throw new Error("Host loadSkills must not read sandbox paths");
    },
    createAgentSession: async () => {
      let listener: ((event: Record<string, unknown>) => void) | undefined;
      return {
        session: {
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
          dispose() {},
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
  });

  it("preserves native skillPaths when no ToolExecutor is injected", async () => {
    const events = await collect(new PiAgentAdapter().run(input(false)));

    expect(events.some((event) => event.type === "session.error")).toBe(false);
    expect(sdkSeam.loadSkillsCalls).toBe(0);
    expect(sdkSeam.resourceLoaderOptions[0]).toMatchObject({
      additionalSkillPaths: ["/skills/skill_abc"],
      noContextFiles: true,
    });
  });
});
