import { describe, it, expect, beforeEach } from "vitest";
import { createApp } from "../src/app.js";
import type { ApiKeyStore } from "../src/types.js";
import { InMemoryAgentStore, InMemoryAgentFileStore } from "@oma-server/store-memory";

const emptyApiKeyStore: ApiKeyStore = { async findByKeyHash() { return null; } };

async function setup() {
  process.env.AUTH_DISABLED = "true";
  const agentStore = new InMemoryAgentStore();
  const agentFileStore = new InMemoryAgentFileStore();
  const app = createApp({ apiKeyStore: emptyApiKeyStore, agentStore, agentFileStore });
  // AUTH_DISABLED ⇒ every request runs as tenant "dev".
  const agent = await agentStore.create({
    tenantId: "dev",
    name: "A",
    model: "m",
    system: "s",
    runtime: "pi-agent",
  });
  return { app, agentStore, agentFileStore, agentId: agent.id };
}

describe("Agent Files routes", () => {
  beforeEach(() => {
    process.env.AUTH_DISABLED = "true";
  });

  it("upsert-then-read returns identical content", async () => {
    const { app, agentId } = await setup();
    const put = await app.request(`/v1/agents/${agentId}/files/SOUL`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "# Soul\nBe warm." }),
    });
    expect(put.status).toBe(200);
    const putBody = await put.json();
    expect(putBody.filename).toBe("SOUL");
    expect(putBody.content).toBe("# Soul\nBe warm.");

    const get = await app.request(`/v1/agents/${agentId}/files/SOUL`);
    expect(get.status).toBe(200);
    const getBody = await get.json();
    expect(getBody.content).toBe("# Soul\nBe warm.");
  });

  it("overwrites on repeated upsert", async () => {
    const { app, agentId } = await setup();
    await app.request(`/v1/agents/${agentId}/files/IDENTITY`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "v1" }),
    });
    await app.request(`/v1/agents/${agentId}/files/IDENTITY`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "v2" }),
    });
    const get = await app.request(`/v1/agents/${agentId}/files/IDENTITY`);
    expect((await get.json()).content).toBe("v2");
  });

  it("list omits content", async () => {
    const { app, agentId } = await setup();
    await app.request(`/v1/agents/${agentId}/files/SOUL`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "secret body" }),
    });
    const res = await app.request(`/v1/agents/${agentId}/files`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.has_more).toBe(false);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].filename).toBe("SOUL");
    expect(body.data[0]).not.toHaveProperty("content");
  });

  it("rejects unknown filenames with 400", async () => {
    const { app, agentId } = await setup();
    const res = await app.request(`/v1/agents/${agentId}/files/NOPE`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "x" }),
    });
    expect(res.status).toBe(400);
  });

  it("keeps unknown filenames as 404 for read and delete", async () => {
    const { app, agentId } = await setup();

    const get = await app.request(`/v1/agents/${agentId}/files/NOPE`);
    expect(get.status).toBe(404);

    const del = await app.request(`/v1/agents/${agentId}/files/NOPE`, {
      method: "DELETE",
    });
    expect(del.status).toBe(404);
  });

  it("delete removes the file", async () => {
    const { app, agentId } = await setup();
    await app.request(`/v1/agents/${agentId}/files/USER`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "u" }),
    });
    const del = await app.request(`/v1/agents/${agentId}/files/USER`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect((await del.json()).type).toBe("agent_file_deleted");
    const get = await app.request(`/v1/agents/${agentId}/files/USER`);
    expect(get.status).toBe(404);
  });

  it("cross-tenant access returns 404 (agent belongs to another tenant)", async () => {
    const { app, agentStore } = await setup();
    // An agent owned by a different tenant must be invisible to tenant "dev".
    const other = await agentStore.create({
      tenantId: "other",
      name: "B",
      model: "m",
      system: "s",
      runtime: "pi-agent",
    });
    const list = await app.request(`/v1/agents/${other.id}/files`);
    expect(list.status).toBe(404);
    const put = await app.request(`/v1/agents/${other.id}/files/SOUL`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "x" }),
    });
    expect(put.status).toBe(404);
  });

  it("returns 404 for a missing file", async () => {
    const { app, agentId } = await setup();
    const res = await app.request(`/v1/agents/${agentId}/files/MEMORY`);
    expect(res.status).toBe(404);
  });
});
