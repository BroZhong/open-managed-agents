import { describe, expect, it } from "vitest";
import { PiAgentAdapter } from "@open-managed-agents/adapter-pi-agent";
import { InProcessEventStreamHub } from "@oma-server/event-log";
import { SessionRouter } from "@oma-server/session-router";
import { createMemoryStores } from "@oma-server/store-memory";
import { createApp } from "../src/app.js";
import { LoopScheduler } from "../src/lib/loop-scheduler.js";

const liveIt = process.env.RUN_LIVE_SUPABASE_LOOP_E2E === "1" ? it : it.skip;

describe("live five-minute Loop + Supabase MCP", () => {
  liveIt("reads the last week and produces evidence-backed Agent improvements", async () => {
    process.env.AUTH_DISABLED = "true";
    process.env.OMA_SUPABASE_ALLOWED_TENANTS = "dev";
    const hasAccessKeyId = Boolean(
      process.env.ALIYUN_ACCESS_KEY_ID
      || process.env.ALIBABA_CLOUD_ACCESS_KEY_ID,
    );
    const hasAccessKeySecret = Boolean(
      process.env.ALIYUN_ACCESS_KEY_SECRET
      || process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET,
    );
    if (!hasAccessKeyId || !hasAccessKeySecret || !process.env.ALIYUN_REGION) {
      throw new Error("Live Supabase Loop E2E environment is incomplete");
    }

    const clock = new Date("2026-07-14T00:00:00.000Z");
    const stores = createMemoryStores();
    const eventStreamHub = new InProcessEventStreamHub();
    const sessionRouter = new SessionRouter({
      eventLogStore: stores.eventLogStore,
      pendingEventStore: stores.pendingEventStore,
      sessionStore: stores.sessionStore,
      eventStreamHub,
      agentStore: stores.agentStore,
      resolveAdapter: () => new PiAgentAdapter(),
    });
    const app = createApp({
      apiKeyStore: stores.apiKeyStore,
      agentStore: stores.agentStore,
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
        name: "Live Session Analyst",
        model: "openai-codex/gpt-5.5",
        system: [
          "Analyze this Agent's own recent Session evidence.",
          "Use only the managed session-data MCP for data access.",
          "Never invent counts or outcomes.",
          "Your final answer must start with OPTIMIZATION_RECOMMENDATIONS and contain three concrete improvements tied to observed evidence.",
        ].join(" "),
        runtime: "pi-agent",
        sandbox: { enabled: false },
        mcpServers: [{
          catalogId: "aliyun-rds-supabase",
          name: "session-data",
          description: "Read tenant-scoped Sessions and canonical events.",
        }],
      }),
    });
    expect(agentResponse.status).toBe(201);
    const agent = await agentResponse.json();

    const loopResponse = await app.request(`/v1/agents/${agent.id}/loops`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Five-minute live Session review",
        prompt: [
          "Call session-data.query_recent_sessions for exactly the last 7 days.",
          "Review returned Session and event patterns, including errors, retries, and incomplete outcomes.",
          "Then produce the required evidence-backed Agent optimization recommendations.",
        ].join(" "),
        intervalMinutes: 5,
        enabled: true,
      }),
    });
    expect(loopResponse.status).toBe(201);
    const loop = await loopResponse.json();

    const scheduler = new LoopScheduler({
      loopStore: stores.loopStore,
      sessionRouter,
    });
    expect(await scheduler.runDue(new Date("2026-07-14T00:05:00.000Z"))).toBe(1);
    expect(await sessionRouter.waitForIdle(180_000)).toBe(true);

    const sessions = await stores.sessionStore.list("dev", { loopId: loop.id });
    expect(sessions.data).toHaveLength(1);
    const events = await stores.eventLogStore.getEvents(sessions.data[0].id, { limit: 500 });
    if (events.data.some((event) => event.type === "session.error")) {
      throw new Error("Live Loop emitted a Session error");
    }
    const toolUse = events.data.find((event) =>
      event.type === "agent.mcp_tool_use"
      && (event.data as { name?: string }).name === "query_recent_sessions"
    );
    expect(toolUse?.data).toMatchObject({
      input: { days: 7 },
    });
    const toolResult = events.data.find(
      (event) => event.type === "agent.mcp_tool_result",
    );
    const resultText = (
      toolResult?.data as { content?: Array<{ text?: string }> } | undefined
    )?.content?.map((block) => block.text ?? "").join("") ?? "";
    const result = JSON.parse(resultText) as {
      window_days?: number;
      sessions?: unknown[];
    };
    expect(result.window_days).toBe(7);
    expect(result.sessions?.length).toBeGreaterThan(0);
    const finalMessages = events.data
      .filter((event) => event.type === "agent.message")
      .flatMap((event) => (event.data as { content?: Array<{ text?: string }> }).content ?? [])
      .map((block) => block.text ?? "");
    if (!finalMessages.some((message) => message.startsWith("OPTIMIZATION_RECOMMENDATIONS"))) {
      throw new Error("Live Loop did not produce the required optimization report");
    }
  }, 240_000);
});
