import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStores } from "@oma-server/store-memory";
import { DefaultSandboxManager, FakeSandboxClient, SandboxCreateRejected, type SandboxEnvironmentBinding } from "@oma-server/sandbox";
import { environmentBindingId, workspaceObjectPrefix, type Session } from "@oma-server/store";
import { createApp } from "../src/app.js";

/**
 * GET /v1/sessions/{id} reports the Session's Sandbox environment (ADR-0023,
 * #290): read from the binding, which a Child Session shares with its root,
 * and written by the Sandbox Manager as its preparations fail and recover.
 */
const oldAuth = process.env.AUTH_DISABLED;
beforeEach(() => { process.env.AUTH_DISABLED = "true"; });
afterEach(() => { if (oldAuth === undefined) delete process.env.AUTH_DISABLED; else process.env.AUTH_DISABLED = oldAuth; vi.restoreAllMocks(); });

const workspaceMount = { bucket: "agentry", agentName: "agentry-workspace", pvName: "agentry-workspace-oss", credentialProviderName: "agentry-oss-rw" };
const iso = (date: Date | null | undefined) => date ? date.toISOString() : date;

async function setup() {
  const stores = createMemoryStores();
  const app = createApp({ ...stores, apiKeyStore: { findByKeyHash: async () => null } });
  const agent = await stores.agentStore.create({ tenantId: "dev", name: "Agent", model: "mock", system: "", runtime: "mock" });
  const workspace = await stores.workspaceStore.create({ tenantId: "dev" });
  const root = await stores.sessionStore.create({ tenantId: "dev", agentId: agent.id, agent, workspaceId: workspace.id });
  const child = await stores.sessionStore.create({ tenantId: "dev", agentId: agent.id, agent, workspaceId: workspace.id,
    delegation: { parentSessionId: root.id, parentTurnId: "turn_1", parentToolUseId: "call_agent", sandboxSessionId: root.id } });
  const gateway = new FakeSandboxClient();
  const manager = new DefaultSandboxManager({ sandboxClient: gateway, environment: "test" });
  /** A Turn's Sandbox session of `session`, coordinated through its binding as a Runner's are. */
  const sandbox = (session: Session) => {
    const bindingId = environmentBindingId(session);
    const binding: SandboxEnvironmentBinding = { id: bindingId, withLock: (work) => stores.delegationStore.withEnvironmentLock(bindingId, work) };
    return manager.open({ tenantId: "dev", workspaceId: workspace.id,
      workspaceMount: { ...workspaceMount, prefix: workspaceObjectPrefix("dev", workspace.id) } }, binding);
  };
  const environment = async (session: Session) => {
    const response = await app.request(`/v1/sessions/${session.id}`);
    expect(response.status).toBe(200);
    const body = await response.json() as { id: string; environment: unknown };
    expect(body.id).toBe(session.id);
    return body.environment as { state: string; since: string | null; last_error: { code: string; reason: string; at: string } | null };
  };
  return { stores, app, root, child, gateway, sandbox, environment };
}

describe("GET /v1/sessions/{id} reports the Session's environment (ADR-0023, #290)", () => {
  it("is cold before any tool used the Sandbox, with no time recorded", async () => {
    const h = await setup();
    expect(await h.environment(h.root)).toEqual({ state: "cold", since: null, last_error: null });
  });

  it("is creating from the creation intent's start while a create is in flight", async () => {
    const h = await setup();
    let release!: () => void;
    h.gateway.createFault = (step) => step === "claim" ? new Promise<void>((resolve) => { release = resolve; }) : undefined;
    const writing = h.sandbox(h.root).writeFile("a.txt", "x");
    await vi.waitFor(() => expect(release).toBeDefined());
    const { creatingSince } = await h.stores.delegationStore.withEnvironmentLock(h.root.id, async (binding) => ({ value: binding }));
    expect(await h.environment(h.root)).toEqual({ state: "creating", since: iso(creatingSince), last_error: null });
    release();
    await writing;
  });

  it("is ready once a tool created the Sandbox, since the binding recorded it", async () => {
    const h = await setup();
    const before = Date.now();
    await h.sandbox(h.root).writeFile("a.txt", "x");
    const environment = await h.environment(h.root);
    expect(environment).toMatchObject({ state: "ready", last_error: null });
    expect(Date.parse(environment.since!)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(environment.since!)).toBeLessThanOrEqual(Date.now());
  });

  it("is unavailable after an environment failure, whose code, reason and time it reports until a later tool recovers", async () => {
    const h = await setup();
    h.gateway.createFault = (step) => { if (step === "claim") throw new SandboxCreateRejected(403); };
    const session = h.sandbox(h.root);
    const before = Date.now();
    await expect(session.writeFile("a.txt", "x")).rejects.toMatchObject({ code: "sandbox_unavailable", reason: "rejected" });
    await vi.waitFor(async () => expect((await h.environment(h.root)).state).toBe("unavailable"));
    const failed = await h.environment(h.root);
    expect(failed).toEqual({ state: "unavailable", since: failed.last_error!.at,
      last_error: { code: "sandbox_unavailable", reason: "rejected", at: expect.any(String) } });
    expect(Date.parse(failed.last_error!.at)).toBeGreaterThanOrEqual(before);

    // The gateway answers again: the next tool call creates the Sandbox and clears the failure.
    h.gateway.createFault = undefined;
    await session.writeFile("a.txt", "x");
    const recovered = await h.environment(h.root);
    expect(recovered).toMatchObject({ state: "ready", last_error: null });
    expect(Date.parse(recovered.since!)).toBeGreaterThanOrEqual(Date.parse(failed.last_error!.at));

    // A Ready binding whose Sandbox cannot be reached at the next Turn's start, then can.
    const reconnect = vi.spyOn(h.gateway, "reconnect").mockRejectedValue(new Error("connect ECONNREFUSED"));
    await expect(h.sandbox(h.root).prepare()).rejects.toMatchObject({ reason: "unreachable" });
    await vi.waitFor(async () => expect(await h.environment(h.root)).toMatchObject({ state: "unavailable", last_error: { reason: "unreachable" } }));
    reconnect.mockRestore();
    await h.sandbox(h.root).prepare();
    expect(await h.environment(h.root)).toMatchObject({ state: "ready", last_error: null });
  });

  it("reports the binding a Child Session shares with its root, whichever of them used it", async () => {
    const h = await setup();
    expect(await h.environment(h.child)).toEqual(await h.environment(h.root));
    // The child's tool creates the shared Sandbox.
    await h.sandbox(h.child).writeFile("a.txt", "x");
    const ready = await h.environment(h.root);
    expect(ready.state).toBe("ready");
    expect(await h.environment(h.child)).toEqual(ready);
    // The root's Turn cannot reach it.
    vi.spyOn(h.gateway, "reconnect").mockRejectedValue(new Error("connect ECONNREFUSED"));
    await expect(h.sandbox(h.root).prepare()).rejects.toMatchObject({ reason: "unreachable" });
    await vi.waitFor(async () => expect((await h.environment(h.child)).state).toBe("unavailable"));
    expect(await h.environment(h.child)).toEqual(await h.environment(h.root));
  });

  it("leaves it out for share credentials, which receive display fields only", async () => {
    const h = await setup();
    const share = await h.stores.sessionShareStore.getOrCreate(h.root.id);
    const response = await h.app.request(`/v1/sessions/${h.root.id}`, { headers: { "x-session-share": share.id } });
    expect(response.status).toBe(200);
    expect(await response.json()).not.toHaveProperty("environment");
  });
});
