import { describe, it, expect } from "vitest";
import { SessionRouter } from "../src/session-router.js";
import { InProcessEventStreamHub } from "@oma-server/event-log";
import {
  InMemoryEventLogStore,
  InMemoryPendingEventStore,
  InMemorySessionStore,
  InMemoryAgentFileStore,
  InMemorySkillStore,
  InMemorySkillArtifactStore,
} from "@oma-server/store-memory";
import type { Agent } from "@oma-server/store";
import type { Adapter, AdapterInput, SessionEvent } from "@open-managed-agents/adapter-core";

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
    async *run(input: AdapterInput): AsyncIterable<SessionEvent> {
      captured = input;
      yield {
        id: "evt_1",
        timestamp: "2024-01-01T00:00:00.000Z",
        type: "agent.message",
        content: [{ type: "text", text: "ok" }],
      } as SessionEvent;
    },
  };
  return { adapter, last: () => captured };
}

async function runOneTurn(deps: {
  agentFileStore?: InMemoryAgentFileStore;
  skillStore?: InMemorySkillStore;
  skillArtifactStore?: InMemorySkillArtifactStore;
  agent?: Agent;
}) {
  const eventLogStore = new InMemoryEventLogStore();
  const pendingEventStore = new InMemoryPendingEventStore();
  const sessionStore = new InMemorySessionStore();
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
    skillArtifactStore: deps.skillArtifactStore,
  });

  const session = await sessionStore.create({
    tenantId: agent.tenantId,
    agentId: agent.id,
    agent,
    workspaceId: "ws_test",
  });
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

describe("session-router: equipped Skills → in-sandbox skillPaths (/skills/<id>)", () => {
  it("passes each valid equipped Skill as an in-sandbox /skills/<id> path", async () => {
    // Skills are no longer materialized to a Host temp dir — they are projected
    // into the sandbox at /skills/<id> (ADR-0005 §4), and `skillPaths` carries
    // those in-sandbox roots so Pi's sandbox-mapped read tool can load them.
    const skillStore = new InMemorySkillStore();
    const skillArtifactStore = new InMemorySkillArtifactStore();
    const skill = await skillStore.create({
      tenantId: "tenant_1",
      name: "greeter",
      description: "greets",
      ownerType: "agent",
      ownerId: "agent_1",
    });
    await skillArtifactStore.put("tenant_1", skill.id, "SKILL.md", "---\nname: greeter\n---\nhi");

    const agent: Agent = { ...AGENT, skills: [skill.id] };
    const input = await runOneTurn({ skillStore, skillArtifactStore, agent });

    expect(input?.agent.skillPaths).toEqual([`/skills/${skill.id}`]);
    expect(input?.agent.skillDescriptors).toEqual([
      {
        name: "greeter",
        description: "greets",
        path: `/skills/${skill.id}/SKILL.md`,
      },
    ]);
  });

  it("skips a Skill with zero files (never becomes a skillPath)", async () => {
    // The zero-files skip preserved from materializeSkills: a Skill whose store
    // has no files must not produce a projection / skillPath.
    const skillStore = new InMemorySkillStore();
    const skillArtifactStore = new InMemorySkillArtifactStore();
    const empty = await skillStore.create({
      tenantId: "tenant_1",
      name: "empty",
      description: "no files",
    });

    const agent: Agent = { ...AGENT, skills: [empty.id] };
    const input = await runOneTurn({ skillStore, skillArtifactStore, agent });

    expect(input?.agent.skillPaths).toBeUndefined();
  });

  it("no equipped Skills ⇒ skillPaths undefined", async () => {
    const skillStore = new InMemorySkillStore();
    const skillArtifactStore = new InMemorySkillArtifactStore();
    const input = await runOneTurn({ skillStore, skillArtifactStore });
    expect(input?.agent.skillPaths).toBeUndefined();
  });
});
