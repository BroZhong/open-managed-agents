import { describe, expect, it, vi } from "vitest";
import { createMemoryStores } from "@oma-server/store-memory";
import { DefaultSandboxManager, DefaultTurnSandboxes, FakeSandboxClient, EMPTY_SKILL_SET, PLATFORM_DEFAULT_ENV, WORKSPACE_ENV } from "@oma-server/sandbox";
import { EnvironmentService, SandboxEnvironmentResolver } from "../src/lib/environments.js";

const KEY = "cd".repeat(32);
const CANARY = "sk-canary-" + "a1b2".repeat(8);
const IMAGE = "registry.example/welltop/oma-environments@sha256:" + "f".repeat(64);
const workspaceMount = { bucket: "agentry", agentName: "agentry-workspace", pvName: "agentry-workspace-oss", credentialProviderName: "agentry-oss-rw" };

/**
 * A Runner's view of the Environments its Sessions run in (ADR-0024): the
 * variables of every command, Tenant secrets opened and platform references
 * resolved at injection, as an Environment created and edited through the
 * API leaves them.
 */
async function setup(platform: Record<string, string> = { VFS_TOKEN: "platform-vfs" }) {
  const stores = createMemoryStores();
  const service = new EnvironmentService(stores.environmentStore, KEY);
  await stores.environmentStore.create({
    id: "env_video_production", owner: { ownerType: "platform" }, name: "video-production", description: "", baseImage: "oma-media",
    initScript: "", env: [{ name: "VFS_TOKEN", secretRef: { source: "platform", key: "VFS_TOKEN" } },
      { name: "GEMINI_API_KEY", secretRef: { source: "platform", key: "GEMINI_API_KEY" } }], encryptedSecrets: {},
  });
  await stores.environmentStore.buildNow("env_video_production", IMAGE);
  const warn = vi.fn();
  const resolver = new SandboxEnvironmentResolver(stores.environmentStore, KEY, platform, { warn });
  return { stores, service, resolver, warn };
}

describe("SandboxEnvironmentResolver", () => {
  it("resolves plain values, Tenant secrets and platform references in the Environment's order, deleted or not", async () => {
    const { service, resolver, warn } = await setup();
    const copy = await service.create("t1", { from: "env_video_production", name: "mine",
      env: [
        { name: "VFS_TOKEN", secretRef: { source: "platform", key: "VFS_TOKEN" } },
        { name: "GEMINI_API_KEY", secretRef: { source: "platform", key: "GEMINI_API_KEY" } },
        { name: "API_TOKEN", secretRef: { source: "environment", key: "API_TOKEN" }, value: CANARY },
        { name: "MODE", value: "plain" },
      ] });
    expect(await resolver.variables("t1", copy.id)).toEqual({ VFS_TOKEN: "platform-vfs", API_TOKEN: CANARY, MODE: "plain" });
    // A reference the deployment does not provide is left out, reported once by name, never by value.
    await resolver.variables("t1", copy.id);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toContain("GEMINI_API_KEY refers to platform secret GEMINI_API_KEY");
    expect(JSON.stringify(warn.mock.calls)).not.toContain(CANARY);
    await service.delete("t1", copy.id);
    expect(await resolver.variables("t1", copy.id)).toMatchObject({ API_TOKEN: CANARY });
    // Another Tenant sees nothing of it.
    expect(await resolver.variables("t2", copy.id)).toEqual({});
    expect(await resolver.image("t2", copy.id)).toBeNull();
    expect(await resolver.image("t2", "env_video_production")).toBe(IMAGE);
  });

  it("refuses to open Tenant secrets without the key they were sealed under", async () => {
    const { stores, service } = await setup();
    const env = await service.create("t1", { name: "secret", baseImage: "oma-base",
      env: [{ name: "API_TOKEN", secretRef: { source: "environment", key: "API_TOKEN" }, value: CANARY }] });
    await expect(new SandboxEnvironmentResolver(stores.environmentStore, "ef".repeat(32), {}).variables("t1", env.id)).rejects.toThrow();
    await expect(new SandboxEnvironmentResolver(stores.environmentStore, undefined, {}).variables("t1", env.id)).rejects.toThrow("OMA_PROVIDER_ENCRYPTION_KEY");
  });
});

describe("a Session's commands in its Environment, edited through the API (ADR-0024)", () => {
  it("receive the edited variables from the next command of the running Sandbox", async () => {
    const { stores, service, resolver } = await setup();
    const env = await service.create("t1", { name: "tools", baseImage: "oma-base",
      env: [{ name: "MODE", value: "first" }, { name: "API_TOKEN", secretRef: { source: "environment", key: "API_TOKEN" }, value: CANARY }] });
    await stores.environmentStore.buildNow(env.id, IMAGE);
    const client = new FakeSandboxClient();
    const sandboxes = new DefaultTurnSandboxes({ manager: new DefaultSandboxManager({ sandboxClient: client, environment: "test" }),
      bindings: stores.delegationStore, sessions: stores.sessionStore, workspaceMount, environments: resolver,
      defaultSandboxEnv: { BASE_SECRET: CANARY } });
    const agent = await stores.agentStore.create({ tenantId: "t1", name: "A", model: "m", system: "s", runtime: "pi-agent", sandbox: { enabled: true }, environmentId: env.id });
    const workspace = await stores.workspaceStore.create({ tenantId: "t1" });
    const session = await stores.sessionStore.create({ tenantId: "t1", agentId: agent.id, agent, workspaceId: workspace.id, environmentId: env.id });
    await stores.pendingEventStore.enqueue(session.id, { type: "user.message", data: { content: [] }, sessionThreadId: "sthr_primary" });
    const claim = (await stores.pendingEventStore.claim(session.id, "runner", 60_000))!;
    const lease = (await sandboxes.acquire({ session, agent, fence: { eventId: claim.event.id, ownerId: claim.ownerId, generation: claim.generation },
      signal: new AbortController().signal, skills: EMPTY_SKILL_SET, skillInstallFailed: () => {} }))!;
    const printenv = async (...names: string[]) => {
      let out = "";
      for await (const chunk of lease.executor!.exec(["printenv", ...names])) out += chunk.text;
      return out.split("\n").slice(0, -1);
    };
    expect(await printenv("MODE", "API_TOKEN", "PIP_INDEX_URL", "HOME")).toEqual(["first", CANARY, PLATFORM_DEFAULT_ENV.PIP_INDEX_URL, WORKSPACE_ENV.HOME]);
    await service.update("t1", env.id, { env: [{ name: "MODE", value: "second" }] });
    expect(await printenv("MODE")).toEqual(["second"]);
    expect(await printenv("API_TOKEN")).toEqual([]);
    expect(client.created).toHaveLength(1);
    // The creation carried neither the Environment's secret nor the deployment's base Secret.
    expect(JSON.stringify(client.createOptsOf(client.created[0]!))).not.toContain(CANARY);
  });
});
