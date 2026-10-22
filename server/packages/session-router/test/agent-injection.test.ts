import { describe, it, expect } from "vitest";
import { SessionRouter } from "../src/session-router.js";
import { InProcessEventStreamHub } from "@oma-server/event-log";
import {
  createMemoryStores,
  InMemoryAgentFileStore,
  InMemorySkillStore,
} from "@oma-server/store-memory";
import { packSkillBundle, type Agent } from "@oma-server/store";
import type { Adapter, AdapterInput, SessionEvent } from "@open-managed-agents/adapter-core";
import { journalWriter } from "@open-managed-agents/adapter-mock";

const AGENT: Agent = {
  id: "agent_1",
  tenantId: "tenant_1",
  name: "Test",
  model: "m",
  system: "You are helpful",
  runtime: "pi-agent",
  // Opt out of the mandatory sandbox (#54): these tests run with no
  // toolExecutorFactory and assert on the captured AdapterInput, so the agent
  // must be opted-out to avoid the sandbox_unavailable fail-loud path.
  sandbox: { enabled: false },
  createdAt: new Date(),
  updatedAt: new Date(),
};

/** An Adapter that records the AdapterInput it was called with, then ends. */
function capturingAdapter(): { adapter: Adapter; last: () => AdapterInput | undefined } {
  let captured: AdapterInput | undefined;
  const adapter: Adapter = {
    async run(input: AdapterInput) {
      const write = journalWriter(input);
      captured = input;
      await write({
        id: "evt_1",
        timestamp: "2024-01-01T00:00:00.000Z",
        type: "agent.message",
        content: [{ type: "text", text: "ok" }],
      } as SessionEvent);
      return "finished";
    },
  };
  return { adapter, last: () => captured };
}

async function runOneTurn(deps: {
  agentFileStore?: InMemoryAgentFileStore;
  skillStore?: InMemorySkillStore;
  agent?: Agent;
  thinking?: Agent["thinking"];
}) {
  const { eventLogStore, pendingEventStore, sessionStore } = createMemoryStores();
  const eventStreamHub = new InProcessEventStreamHub();
  const { adapter, last } = capturingAdapter();
  const agent = deps.agent ?? AGENT;

  const router = new SessionRouter({
    eventLogStore,
    pendingEventStore,
    sessionStore,
    eventStreamHub,
    resolveAdapter: () => adapter,
    agentFileStore: deps.agentFileStore,
    skillStore: deps.skillStore,
  });

  const session = await sessionStore.create({
    tenantId: agent.tenantId,
    agentId: agent.id,
    agent,
    workspaceId: "ws_test",
  });
  if (deps.thinking !== undefined) await sessionStore.setThinking(session.id, deps.thinking);
  await pendingEventStore.enqueue(session.id, {
    type: "user.message",
    data: { content: [{ type: "text", text: "hi" }] },
    sessionThreadId: "sthr_primary",
  });
  await router.handleNewEvent(session.id, agent);
  return last();
}

describe("session-router: Agent Files → appendSystemPrompt", () => {
  it("assembles Files in fixed order IDENTITY → SOUL → USER → MEMORY", async () => {
    const agentFileStore = new InMemoryAgentFileStore();
    // Insert out of order to prove the router imposes the canonical order.
    await agentFileStore.upsert("tenant_1", "agent_1", "USER", "U");
    await agentFileStore.upsert("tenant_1", "agent_1", "MEMORY", "M");
    await agentFileStore.upsert("tenant_1", "agent_1", "IDENTITY", "I");
    await agentFileStore.upsert("tenant_1", "agent_1", "SOUL", "S");

    const input = await runOneTurn({ agentFileStore });
    expect(input?.agent.appendSystemPrompt).toEqual(["I", "S", "U", "M"]);
  });

  it("skips missing files", async () => {
    const agentFileStore = new InMemoryAgentFileStore();
    await agentFileStore.upsert("tenant_1", "agent_1", "IDENTITY", "I");
    await agentFileStore.upsert("tenant_1", "agent_1", "USER", "U");

    const input = await runOneTurn({ agentFileStore });
    expect(input?.agent.appendSystemPrompt).toEqual(["I", "U"]);
  });

  it("no store ⇒ appendSystemPrompt undefined (no regression)", async () => {
    const input = await runOneTurn({});
    expect(input?.agent.appendSystemPrompt).toBeUndefined();
  });
});

describe("session-router: equipped Skills → in-sandbox skillPaths (/skills/<skill-name>)", () => {
  it("passes each valid equipped Skill by name while resolving content by ID", async () => {
    // Skills are not materialized on the Host — the Sandbox Manager installs
    // them at /skills/<skill-name> (ADR-0022), and `skillPaths` carries those
    // in-sandbox roots so Pi's sandbox-mapped read tool can load them.
    const skillStore = new InMemorySkillStore();
    const packed = await packSkillBundle([{ path: "SKILL.md", body: new TextEncoder().encode("---\nname: greeter\n---\nhi") }]);
    const skill = await skillStore.create({
      tenantId: "tenant_1",
      name: "greeter",
      description: "greets",
      ownerType: "agent",
      ownerId: "agent_1",
      bundleSha256: packed.sha256,
      bundleSize: packed.size,
    });

    const agent: Agent = { ...AGENT, skills: [skill.id] };
    const input = await runOneTurn({ skillStore, agent });

    expect(input?.agent.skillPaths).toEqual(["/skills/greeter"]);
    expect(input?.agent.skillDescriptors).toEqual([
      {
        name: "greeter",
        description: "greets",
        path: "/skills/greeter/SKILL.md",
      },
    ]);
  });

  it("skips a Skill without a Skill Bundle (never becomes a skillPath)", async () => {
    // A Skill with no bundle has no files to install, so it is not offered.
    const skillStore = new InMemorySkillStore();
    const empty = await skillStore.create({
      tenantId: "tenant_1",
      name: "empty",
      description: "no files",
      ownerType: "agent",
      ownerId: "agent_1",
    });

    const agent: Agent = { ...AGENT, skills: [empty.id] };
    const input = await runOneTurn({ skillStore, agent });

    expect(input?.agent.skillPaths).toBeUndefined();
  });

  it("no equipped Skills ⇒ skillPaths undefined", async () => {
    const skillStore = new InMemorySkillStore();
    const input = await runOneTurn({ skillStore });
    expect(input?.agent.skillPaths).toBeUndefined();
  });
});


describe("Session thinking precedence", () => {
  it.each([
    [undefined, "medium"], [null, "medium"], ["off", "off"], ["max", "max"],
  ] as const)("uses Session preference %s over Agent medium", async (thinking, expected) => {
    const input = await runOneTurn({ agent: { ...AGENT, thinking: "medium" }, thinking });
    expect(input?.agent.thinking).toBe(expected);
  });
});
