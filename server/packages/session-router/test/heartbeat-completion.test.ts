import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createMemoryStores } from "@oma-server/store-memory";
import { InProcessEventStreamHub } from "@oma-server/event-log";
import { DefaultSandboxManager, DefaultTurnSandboxes, FakeSandboxClient } from "@oma-server/sandbox";
import type { SessionEvent } from "@open-managed-agents/adapter-core";
import { journalWriter } from "@open-managed-agents/adapter-mock";
import { SessionRouter } from "../src/session-router.js";

/**
 * Production logged "Runner drain failed: PendingLeaseLostError" after Turns
 * that had completed normally: the acknowledgement deleted the input's claim
 * row, and the heartbeat, stopped only after the Sandbox activity was
 * finished, renewed a claim that no longer existed.
 */

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const event = (type: string, data: object = {}) => ({ id: randomUUID(), timestamp: new Date().toISOString(), type, ...data }) as SessionEvent;

describe("the claim heartbeat of a completed Turn", () => {
  it("stops before the input is acknowledged, so finishing a slow Sandbox activity reports no lost lease", async () => {
    const stores = createMemoryStores();
    const agent = await stores.agentStore.create({ tenantId: "tenant", name: "Test", model: "test", system: "test",
      runtime: "pi-agent", sandbox: { enabled: true } });
    const workspace = await stores.workspaceStore.create({ tenantId: "tenant" });
    const session = await stores.sessionStore.create({ tenantId: "tenant", agentId: agent.id, agent, workspaceId: workspace.id });
    let finished = false;
    // Finishing the activity takes several renew intervals, as a Sandbox control-plane call can.
    class SlowSandboxes extends DefaultSandboxManager {
      override async beginActivity() { return true; }
      override async finishActivity() { await sleep(150); finished = true; }
    }
    const errors: unknown[] = [];
    const router = new SessionRouter({
      ...stores, eventStreamHub: new InProcessEventStreamHub(),
      resolveAdapter: () => ({ async run(input) {
        await journalWriter(input)(event("agent.message", { content: [{ type: "text", text: "done" }] }));
        return "finished";
      } }),
      sandboxes: new DefaultTurnSandboxes({ manager: new SlowSandboxes({ sandboxClient: new FakeSandboxClient() }),
        bindings: stores.delegationStore, sessions: stores.sessionStore,
        workspaceMount: { bucket: "agentry", agentName: "agentry-workspace", pvName: "agentry-workspace-oss", credentialProviderName: "agentry-oss-rw" },
        onError: ({ error }) => errors.push(error) }),
      pendingClaimOwnerId: "runner", pendingClaimLeaseMs: 500, pendingClaimRenewIntervalMs: 20,
      onDrainError: ({ error }) => errors.push(error),
    });
    await stores.pendingEventStore.enqueue(session.id, {
      type: "user.message", data: { content: [{ type: "text", text: "hi" }] }, sessionThreadId: "sthr_primary",
    });

    await router.handleNewEvent(session.id, agent);
    await sleep(60);

    expect(finished).toBe(true);
    expect((await stores.eventLogStore.getEvents(session.id, { limit: 100 })).data.filter((stored) => stored.type === "session.turn_completed")).toHaveLength(1);
    expect(errors).toEqual([]);
  });
});
