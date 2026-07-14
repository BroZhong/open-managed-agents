import { beforeEach, describe, expect, it } from "vitest";
import { InProcessEventStreamHub } from "@oma-server/event-log";
import { SessionRouter } from "@oma-server/session-router";
import { createMemoryStores } from "@oma-server/store-memory";
import type { LoopStore } from "@oma-server/store";
import type {
  Adapter,
  AdapterInput,
  SessionEvent,
} from "@open-managed-agents/adapter-core";
import { createApp } from "../src/app.js";
import { LoopScheduler } from "../src/lib/loop-scheduler.js";

describe("Loop + managed Supabase MCP end to end", () => {
  beforeEach(() => {
    process.env.AUTH_DISABLED = "true";
    process.env.OMA_SUPABASE_ALLOWED_TENANTS = "dev";
  });

  it("creates a five-minute Loop, runs its Session, and records Agent improvements", async () => {
    const clock = new Date("2026-07-14T00:00:00.000Z");
    const stores = createMemoryStores();
    const eventStreamHub = new InProcessEventStreamHub();
    const adapterInputs: AdapterInput[] = [];
    const adapter: Adapter = {
      async *run(input: AdapterInput): AsyncIterable<SessionEvent> {
        adapterInputs.push(input);
        yield {
          id: "evt_supabase_query",
          timestamp: clock.toISOString(),
          type: "agent.mcp_tool_use",
          toolUseId: "tool_supabase_query",
          serverName: "session-data",
          name: "query_recent_sessions",
          input: {
            days: 7,
            session_limit: 25,
            event_limit_per_session: 50,
          },
        };
        yield {
          id: "evt_supabase_result",
          timestamp: clock.toISOString(),
          type: "agent.mcp_tool_result",
          toolUseId: "tool_supabase_query",
          serverName: "session-data",
          content: [{ type: "text", text: "17 sessions; 3 repeated tool retries" }],
        };
        yield {
          id: "evt_improvements",
          timestamp: clock.toISOString(),
          type: "agent.message",
          content: [{
            type: "text",
            text: "Agent 优化点：为重复工具失败增加一次有界重试，并在失败后给出可执行诊断。",
          }],
        };
      },
    };
    const sessionRouter = new SessionRouter({
      eventLogStore: stores.eventLogStore,
      pendingEventStore: stores.pendingEventStore,
      sessionStore: stores.sessionStore,
      eventStreamHub,
      agentStore: stores.agentStore,
      resolveAdapter: () => adapter,
    });
    const app = createApp({
      apiKeyStore: stores.apiKeyStore,
      agentStore: stores.agentStore,
      agentFileStore: stores.agentFileStore,
      skillStore: stores.skillStore,
      skillArtifactStore: stores.skillArtifactStore,
      sessionStore: stores.sessionStore,
      eventLogStore: stores.eventLogStore,
      pendingEventStore: stores.pendingEventStore,
      workspaceStore: stores.workspaceStore,
      loopStore: stores.loopStore,
      eventStreamHub,
      sessionRouter,
      now: () => clock,
    });

    const agentResponse = await app.request("/v1/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Session Analyst",
        description: "Find recurring ways to improve this Agent.",
        model: "openai-codex/gpt-5.5",
        system: "Use session evidence and return concrete Agent improvements.",
        runtime: "pi-agent",
        sandbox: { enabled: false },
        mcpServers: [{
          catalogId: "aliyun-rds-supabase",
          name: "session-data",
          description: "Read the managed Supabase Session history.",
        }],
      }),
    });
    expect(agentResponse.status).toBe(201);
    const agent = await agentResponse.json();
    expect(agent.mcpServers).toEqual([{
      catalogId: "aliyun-rds-supabase",
      name: "session-data",
      description: "Read the managed Supabase Session history.",
    }]);

    const loopResponse = await app.request(`/v1/agents/${agent.id}/loops`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Five-minute Session Review",
        description: "Review the latest week of managed Sessions.",
        prompt: "Use Supabase to read Sessions from the last seven days and derive concrete Agent improvements.",
        intervalMinutes: 5,
        enabled: true,
      }),
    });
    expect(loopResponse.status).toBe(201);
    const loop = await loopResponse.json();
    expect(loop.nextRunAt).toBe("2026-07-14T00:05:00.000Z");

    let reportUnknownCommitOnce = true;
    const ambiguousCommitLoopStore = {
      async dispatchDue(at: Date, limit: number) {
        const dispatched = await stores.loopStore.dispatchDue(at, limit);
        if (reportUnknownCommitOnce) {
          reportUnknownCommitOnce = false;
          throw new Error("commit outcome unknown");
        }
        return dispatched;
      },
    } as LoopStore;
    const scheduler = new LoopScheduler({
      loopStore: ambiguousCommitLoopStore,
      sessionRouter,
    });
    await expect(scheduler.runDue(new Date("2026-07-14T00:05:00.000Z")))
      .rejects.toThrow("commit outcome unknown");
    expect(await sessionRouter.waitForIdle(1_000)).toBe(true);
    expect(await scheduler.runDue(new Date("2026-07-14T00:05:00.000Z"))).toBe(0);
    expect(await sessionRouter.waitForIdle(1_000)).toBe(true);

    const sessionsResponse = await app.request(`/v1/sessions?loop_id=${loop.id}`);
    expect(sessionsResponse.status).toBe(200);
    const sessions = (await sessionsResponse.json()).data;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      agentId: agent.id,
      loopId: loop.id,
      title: "Five-minute Session Review",
      status: "idle",
    });

    expect(adapterInputs).toHaveLength(1);
    expect(adapterInputs[0].message.content).toEqual([{
      type: "text",
      text: "Use Supabase to read Sessions from the last seven days and derive concrete Agent improvements.",
    }]);
    expect(adapterInputs[0].agent.mcpServers).toEqual([{
      name: "session-data",
      command: process.execPath,
      args: [
        "--import",
        expect.stringMatching(/^file:.*tsx.*loader\.mjs$/),
        expect.stringMatching(/supabase-session-mcp\.ts$/),
      ],
      env: {
        ALIYUN_ACCESS_KEY_ID: "${ALIYUN_ACCESS_KEY_ID}",
        ALIYUN_ACCESS_KEY_SECRET: "${ALIYUN_ACCESS_KEY_SECRET}",
        ALIBABA_CLOUD_ACCESS_KEY_ID: "${ALIBABA_CLOUD_ACCESS_KEY_ID}",
        ALIBABA_CLOUD_ACCESS_KEY_SECRET: "${ALIBABA_CLOUD_ACCESS_KEY_SECRET}",
        ALIYUN_REGION: "${ALIYUN_REGION}",
        OMA_TENANT_ID: "dev",
      },
    }]);

    const events = await stores.eventLogStore.getEvents(sessions[0].id, { limit: 100 });
    expect(events.data.map((event) => event.type)).toEqual([
      "user.message",
      "session.status_running",
      "agent.mcp_tool_use",
      "agent.mcp_tool_result",
      "agent.message",
      "session.status_idle",
      "session.turn_completed",
    ]);
    expect(events.data[4].data).toMatchObject({
      content: [{ type: "text", text: expect.stringContaining("Agent 优化点") }],
    });
  });
});
