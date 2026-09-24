import { describe, it, expect, vi } from "vitest";
import type { ToolFileSystem } from "@open-managed-agents/adapter-core";
import {
  DefaultSandboxManager,
  SandboxSessionClosed,
  type EnvSpec,
  type SandboxEnvironmentBinding,
} from "../src/sandbox-manager.js";
import { FakeSandboxClient } from "../src/fake-sandbox-client.js";
import { FakeProvisionSource } from "../src/provision-source.js";
import type { SandboxLifecycleStore } from '@oma-server/store';

const mount = {
  bucket: "agentry",
  prefix: "tenant_1/ws_1/",
  agentName: "agentry-workspace",
  pvName: "agentry-workspace-oss",
  credentialProviderName: "agentry-oss-rw",
};
function specFor(extra: Partial<EnvSpec> = {}): EnvSpec {
  return {
    tenantId: "tenant_1",
    workspaceId: "ws_1",
    workspaceMount: mount,
    ...extra,
  };
}
function makeManager() {
  const client = new FakeSandboxClient();
  const provision = new FakeProvisionSource();
  const manager = new DefaultSandboxManager({
    sandboxClient: client,
    provisionSources: { s3: provision },
  });
  return { client, provision, manager };
}

describe("mounted Workspace Sandbox Manager", () => {
  it('keeps creation lazy, uses never-timeout, retries failed deletion, and rebuilds the same Workspace', async () => {
    const client = new FakeSandboxClient();
    let storedId: string | null = null;
    let reclaim = false;
    const store: SandboxLifecycleStore = {
      begin: vi.fn(async () => true), finish: vi.fn(async () => {}),
      listManagedBindings: vi.fn(async () => ['root']),
      claimReclamation: vi.fn(async () => reclaim && storedId ? { bindingId: 'root', sandboxId: storedId } : null),
      completeReclamation: vi.fn(async () => { storedId = null; }),
    };
    const manager = new DefaultSandboxManager({ sandboxClient: client, provisionSources: {}, lifecycle: { store, bindingIds: new Set(['root']) } });
    const session = manager.open(specFor(), { id: 'root', withLock: async work => {
      const result = await work(storedId); storedId = result.sandboxId; return result.value;
    } });
    expect(client.created).toHaveLength(0);
    await session.writeFile('saved.txt', 'persistent');
    await session.writeFile('/tmp/temporary', 'local');
    expect(client.createOptsOf(client.created[0]).neverTimeout).toBe(true);
    reclaim = true;
    const destroy = vi.spyOn(client, 'destroy');
    destroy.mockRejectedValueOnce(new Error('network unavailable'));
    await expect(manager.sweepIdle()).rejects.toThrow('network');
    expect(store.completeReclamation).not.toHaveBeenCalled();
    expect(storedId).not.toBeNull();
    await manager.sweepIdle();
    expect(storedId).toBeNull();
    expect(await session.readFile('saved.txt')).toBe('persistent');
    await expect(session.readFile('/tmp/temporary')).rejects.toThrow();
    expect(client.created).toHaveLength(2);
  });

  it('does not issue deletion after a persistence read fails or bypass coordination through reclaim()', async () => {
    const { client } = makeManager();
    const store: SandboxLifecycleStore = {
      begin: vi.fn(async () => true), finish: vi.fn(async () => {}),
      listManagedBindings: vi.fn(async () => ['root']),
      claimReclamation: vi.fn(async () => { throw new Error('database unavailable'); }),
      completeReclamation: vi.fn(async () => {}),
    };
    const manager = new DefaultSandboxManager({ sandboxClient: client, provisionSources: {}, lifecycle: { store, bindingIds: new Set(['root']) } });
    await expect(manager.sweepIdle()).rejects.toThrow('database');
    await expect(manager.reclaim('arbitrary')).rejects.toThrow('ticket');
    expect(client.destroyed).toEqual([]);
  });
  it('continues reclaiming other known-idle bindings after one gateway failure', async () => {
    const client = new FakeSandboxClient();
    const one = await client.create(); const two = await client.create();
    const destroy = client.destroy.bind(client);
    vi.spyOn(client, 'destroy').mockImplementation(async id => {
      if (id === one.id) throw new Error('first gateway unavailable');
      await destroy(id);
    });
    const store: SandboxLifecycleStore = {
      begin: vi.fn(async () => true), finish: vi.fn(async () => {}),
      listManagedBindings: vi.fn(async () => ['one', 'two']),
      claimReclamation: vi.fn(async bindingId => ({ bindingId, sandboxId: bindingId === 'one' ? one.id : two.id })),
      completeReclamation: vi.fn(async () => {}),
    };
    const manager = new DefaultSandboxManager({ sandboxClient: client, provisionSources: {}, lifecycle: { store, bindingIds: new Set(['one', 'two']) } });
    await expect(manager.sweepIdle()).rejects.toThrow('first gateway');
    expect(client.destroyed).toEqual([two.id]);
    expect(store.completeReclamation).toHaveBeenCalledExactlyOnceWith({ bindingId: 'two', sandboxId: two.id });
  });
  it('enumerates adopted bindings dynamically in the all-bindings mode', async () => {
    const client = new FakeSandboxClient();
    const stored = await client.create();
    const store: SandboxLifecycleStore = {
      begin: vi.fn(async () => true), finish: vi.fn(async () => {}),
      listManagedBindings: vi.fn(async () => ['dynamic']),
      claimReclamation: vi.fn(async bindingId => ({ bindingId, sandboxId: stored.id })),
      completeReclamation: vi.fn(async () => {}),
    };
    const manager = new DefaultSandboxManager({
      sandboxClient: client,
      provisionSources: {},
      lifecycle: { store, bindingIds: new Set(), allBindings: true },
    });
    await manager.sweepIdle();
    expect(store.listManagedBindings).toHaveBeenCalledOnce();
    expect(store.claimReclamation).toHaveBeenCalledWith('dynamic');
    expect(store.completeReclamation).toHaveBeenCalledWith({ bindingId: 'dynamic', sandboxId: stored.id });
  });
  it("refreshes renamed Skills after a new Host attaches to a shared environment", async () => {
    const { client, provision, manager } = makeManager();
    let storedId: string | null = null;
    const binding: SandboxEnvironmentBinding = { withLock: async (work) => {
      const result = await work(storedId); storedId = result.sandboxId; return result.value;
    } };
    const source = { kind: "s3", ref: { skillId: "one" } };
    provision.seed(source, { "SKILL.md": "old body" });
    const first = manager.open(specFor({ projections: [{ targetPath: "/skills/old-name", source }] }), binding);
    expect(await first.readFile("/skills/old-name/SKILL.md")).toBe("old body");
    provision.seed(source, { "SKILL.md": "new body" });
    const resumed = manager.open(specFor(), binding);
    await resumed.prepare([{ targetPath: "/skills/new-name", source }]);
    expect(await resumed.readFile("/skills/new-name/SKILL.md")).toBe("new body");
    await expect(resumed.readFile("/skills/old-name/SKILL.md")).rejects.toThrow();
    expect(client.created).toHaveLength(1);
  });

  it("prepares a shared environment with no Skills when its user cannot create /skills", async () => {
    const { client, manager } = makeManager();
    let storedId: string | null = null;
    const binding: SandboxEnvironmentBinding = { withLock: async (work) => {
      const result = await work(storedId); storedId = result.sandboxId; return result.value;
    } };
    const first = manager.open(specFor(), binding);
    await first.writeFile("existing.txt", "kept");
    vi.spyOn(client, "exec").mockImplementation(async function* () { throw new Error("Permission denied creating /skills"); });
    const resumed = manager.open(specFor(), binding);
    await resumed.prepare();
    expect(await resumed.readFile("existing.txt")).toBe("kept");
    expect(client.created).toHaveLength(1);
  });

  it("checks resource users inside the environment lock before disposing a parent", async () => {
    const { client, manager } = makeManager();
    let storedId: string | null = null;
    let insideLock = false;
    const binding: SandboxEnvironmentBinding = {
      withLock: async (work) => {
        insideLock = true;
        try { const result = await work(storedId); storedId = result.sandboxId; return result.value; }
        finally { insideLock = false; }
      },
      canReclaim: async () => { expect(insideLock).toBe(true); return false; },
    };
    const parent = manager.open(specFor(), binding);
    await parent.writeFile("/tmp/shared", "still needed");
    await parent.dispose();
    const child = manager.open(specFor(), binding);
    expect(await child.readFile("/tmp/shared")).toBe("still needed");
    expect(client.destroyed).toHaveLength(0);
  });
  it("checks the mount before native filesystem operations and keeps the capability stable after rebuild", async () => {
    const { client, manager } = makeManager();
    const unavailable = () => { throw new Error("Unexpected filesystem operation"); };
    const nativeRead = vi.fn(async (id: string, path: string) => client.readFileBytes(id, path));
    const nativeWrite = vi.fn(async (id: string, path: string, bytes: Uint8Array) => client.writeFileBytes(id, path, bytes));
    const fileSystem = (id: string): ToolFileSystem => ({
      readFile: (path) => nativeRead(id, path),
      writeFile: (path, bytes) => nativeWrite(id, path, bytes),
      appendFile: unavailable, access: unavailable, stat: unavailable,
      lstat: unavailable, realpath: unavailable, readdir: unavailable,
      mkdir: unavailable, createTempFile: unavailable,
    });
    Object.assign(client, { fileSystem });
    const session = manager.open(specFor());
    const capability = session.fileSystem;
    await capability.writeFile("native.bin", new Uint8Array([0, 255]));
    expect(await capability.readFile("native.bin")).toEqual(new Uint8Array([0, 255]));
    expect(nativeRead.mock.calls[0][1]).toBe("/home/user/workspace/native.bin");
    const first = client.created[0];
    client.setMountFailure(first, "credential unavailable");
    await expect(capability.writeFile("blocked.bin", new Uint8Array())).rejects.toThrow(/Workspace storage/);
    expect(nativeWrite).toHaveBeenCalledTimes(1);
    client.reclaim(first);
    expect(await capability.readFile("native.bin")).toEqual(new Uint8Array([0, 255]));
    expect(session.fileSystem).toBe(capability);
    expect(client.created).toHaveLength(2);
    expect(nativeRead.mock.calls.at(-1)?.[0]).toBe(client.created[1]);
    await session.dispose();
  });

  it("writes are shared immediately and survive disposal and rebuilding", async () => {
    const { client, manager } = makeManager();
    const a = manager.open(specFor());
    const b = manager.open(specFor());
    await a.writeFile("中文 空格.txt", "saved by a");
    expect(await b.readFile("中文 空格.txt")).toBe("saved by a");
    await b.writeFile("other.txt", "saved by b");
    expect(await a.readFile("other.txt")).toBe("saved by b");
    const id = client.created[0];
    client.reclaim(id);
    expect(await a.readFile("中文 空格.txt")).toBe("saved by a");
    await a.dispose();
    await b.dispose();
    const rebuilt = manager.open(specFor());
    expect(await rebuilt.readFile("other.txt")).toBe("saved by b");
  });
  it("rejects projection ancestors and normalized paths into the mounted Workspace", () => {
    const { manager } = makeManager();
    for (const targetPath of [
      "/home/user",
      "/",
      "/skills/../home/user/workspace/skills",
      "skills/writer",
    ]) {
      expect(() =>
        manager.open(
          specFor({
            projections: [{ targetPath, source: { kind: "s3", ref: {} } }],
          }),
        ),
      ).toThrow();
    }
  });

  it("requests the exact trusted CSI prefix and rejects another Workspace before creating", async () => {
    const { client, manager } = makeManager();
    const session = manager.open(specFor());
    await session.writeFile("a", "saved");
    expect(client.createOptsOf(client.created[0]).metadata).toEqual({
      "oma.dev/tenant": "tenant_1",
      "oma.dev/workspace": "ws_1",
      "security.agents.kruise.io/agent-name": "agentry-workspace",
      "e2b.agents.kruise.io/csi-volume-config":
        '[{"pvName":"agentry-workspace-oss","mountPath":"/home/user/workspace","subPath":"tenant_1/ws_1","attributes":{"credentialProviderName":"agentry-oss-rw"}}]',
    });
    expect(() =>
      manager.open(
        specFor({ workspaceMount: { ...mount, prefix: "other/ws_1/" } }),
      ),
    ).toThrow(/prefix/);
    expect(client.created).toHaveLength(1);
  });

  it("a missing mount or expired permissions blocks tools and disposal still preserves saved files", async () => {
    const { client, manager } = makeManager();
    const session = manager.open(specFor());
    await session.writeFile("saved.txt", "already closed");
    const id = client.created[0];
    client.setMountFailure(id, "permission denied");
    await expect(
      session.writeFile("failed.txt", "must not exist"),
    ).rejects.toThrow(/Workspace storage/);
    await expect(session.checkWorkspace()).rejects.toThrow(/Workspace storage/);
    await expect(session.prepare()).rejects.toThrow(/Workspace storage/);
    await session.dispose();
    expect(client.destroyed).toEqual([id]);
    const next = manager.open(specFor());
    expect(await next.readFile("saved.txt")).toBe("already closed");
    await expect(next.readFile("failed.txt")).rejects.toThrow(/no such file/);
    await expect(
      session.writeFile("after-dispose", "x"),
    ).rejects.toBeInstanceOf(SandboxSessionClosed);
  });

  it("a wrong mounted prefix blocks reads until the same mount recovers", async () => {
    const { client, manager } = makeManager();
    const session = manager.open(specFor());
    await session.writeFile("saved.txt", "saved");
    const id = client.created[0];
    client.setMountIdentity(id, {
      mountPath: "/home/user/workspace",
      bucket: "agentry",
      prefix: "tenant_1/other/",
    });
    await expect(session.readFile("saved.txt")).rejects.toThrow(
      /Workspace storage/,
    );
    client.setMountIdentity(id, {
      mountPath: "/home/user/workspace",
      bucket: "agentry",
      prefix: "tenant_1/ws_1/",
    });
    expect(await session.readFile("saved.txt")).toBe("saved");
    expect(client.created).toHaveLength(1);
  });

  it("cleans failed provisioning and allows the next attempt to create again", async () => {
    const { client, manager } = makeManager();
    vi.spyOn(client, "verifyWorkspaceMount").mockRejectedValueOnce(
      new Error("secret provider detail"),
    );
    const session = manager.open(specFor());
    await expect(session.writeFile("a.txt", "first")).rejects.toThrow(
      /Workspace storage/,
    );
    expect(client.destroyed).toEqual([client.created[0]]);
    await session.writeFile("a.txt", "retry");
    expect(await session.readFile("a.txt")).toBe("retry");
    expect(client.created).toHaveLength(2);
  });

  it("reprojects Skills by name including renamed targets, and restores them on rebuild", async () => {
    const { client, manager, provision } = makeManager();
    const source = {
      kind: "s3",
      ref: { tenantId: "tenant_1", skillId: "skill_123" },
    };
    provision.seed(source, { "SKILL.md": "v1", "old.txt": "obsolete" });
    const session = manager.open(
      specFor({ projections: [{ targetPath: "/skills/writer", source }] }),
    );
    expect(await session.readFile("/skills/writer/SKILL.md")).toBe("v1");
    await session.writeFile("data.txt", "workspace");
    const id = client.created[0];
    await client.writeFile(
      id,
      "/home/user/.local/cache.txt",
      "local dependency",
    );
    provision.seed(source, { "SKILL.md": "v2" });
    await session.prepare([{ targetPath: "/skills/editor", source }]);
    expect(await session.readFile("/skills/editor/SKILL.md")).toBe("v2");
    await expect(session.readFile("/skills/writer/SKILL.md")).rejects.toThrow();
    expect((await session.list()).map((entry) => entry.path)).toEqual([
      "data.txt",
    ]);
    expect(await session.readFile("/home/user/.local/cache.txt")).toBe(
      "local dependency",
    );
    client.reclaim(id);
    await expect(session.checkWorkspace()).rejects.toThrow(/Workspace storage/);
    expect(await session.readFile("/skills/editor/SKILL.md")).toBe("v2");
    expect(await session.readFile("data.txt")).toBe("workspace");
    await expect(
      session.readFile("/home/user/.local/cache.txt"),
    ).rejects.toThrow();
  });

  it("keeps another Workspace isolated while same-Workspace overwrites remain last-close wins", async () => {
    const { manager } = makeManager();
    const a = manager.open(specFor());
    const b = manager.open(specFor());
    const other = manager.open(
      specFor({
        workspaceId: "ws_2",
        workspaceMount: { ...mount, prefix: "tenant_1/ws_2/" },
      }),
    );
    await a.writeFile("a.txt", "one");
    await b.writeFile("a.txt", "two");
    await other.writeFile("a.txt", "other");
    expect(await a.readFile("a.txt")).toBe("two");
    expect(await other.readFile("a.txt")).toBe("other");
  });

  it.each(["mount check", "removal", "partial projection"])("removes old Skill names when a failed %s is retried after another rename", async (failure) => {
    const { client, manager, provision } = makeManager();
    const source = { kind: "s3", ref: { tenantId: "tenant_1", skillId: "skill_123" } };
    provision.seed(source, { "SKILL.md": "original" });
    const session = manager.open(specFor({ projections: [{ targetPath: "/skills/writer", source }] }));
    expect(await session.readFile("/skills/writer/SKILL.md")).toBe("original");
    const id = client.created[0];
    provision.seed(source, { "SKILL.md": "renamed", "helper.txt": "helper" });
    if (failure === "mount check") client.setMountFailure(id, "storage offline");
    else if (failure === "removal") vi.spyOn(client, "remove").mockRejectedValueOnce(new Error("remove unavailable"));
    else {
      const write = client.writeFile.bind(client);
      vi.spyOn(client, "writeFile").mockImplementationOnce(write).mockRejectedValueOnce(new Error("copy unavailable"));
    }
    await expect(session.prepare([{ targetPath: "/skills/editor", source }])).rejects.toThrow();
    client.setMountFailure(id);
    await session.prepare([{ targetPath: "/skills/final-name", source }]);
    expect(await session.readFile("/skills/final-name/SKILL.md")).toBe("renamed");
    await expect(session.readFile("/skills/writer/SKILL.md")).rejects.toThrow(/no such file/);
    await expect(session.readFile("/skills/editor/SKILL.md")).rejects.toThrow(/no such file/);
    expect(client.created).toHaveLength(1);
  });

  it("pure chat preparation, availability checks and disposal never create a Sandbox", async () => {
    const { client, manager } = makeManager();
    const session = manager.open(specFor());
    await session.prepare();
    await session.checkWorkspace();
    await session.dispose();
    await session.dispose();
    expect(client.created).toEqual([]);
    expect(client.destroyed).toEqual([]);
  });

  it("concurrent tool calls share one create and keep cwd, env, timeout and Interrupt signal", async () => {
    const { client, manager } = makeManager();
    const session = manager.open(specFor());
    await Promise.all([
      session.writeFile("a", "A"),
      session.writeFile("b", "B"),
    ]);
    expect(client.created).toHaveLength(1);
    const exec = vi.spyOn(client, "exec");
    const signal = new AbortController().signal;
    for await (const _chunk of session.exec(["echo", "hi"], {
      timeoutSeconds: 0,
      signal,
      env: { FOO: "bar" },
    })) {
      /* drain */
    }
    expect(exec).toHaveBeenCalledWith(client.created[0], ["echo", "hi"], {
      cwd: "/home/user/workspace",
      timeoutSeconds: 0,
      signal,
      env: { FOO: "bar" },
    });
  });

  it("retries disposal after a gateway failure without reopening execution", async () => {
    const { client, manager } = makeManager();
    const session = manager.open(specFor());
    await session.writeFile("saved", "kept");
    vi.spyOn(client, "destroy").mockRejectedValueOnce(
      new Error("gateway unavailable"),
    );
    await expect(session.dispose()).rejects.toThrow(/gateway unavailable/);
    await expect(session.readFile("saved")).rejects.toBeInstanceOf(
      SandboxSessionClosed,
    );
    await session.dispose();
    expect(client.destroyed).toHaveLength(1);
  });

  it("does not expose an incompletely projected Sandbox when failed cleanup is retried", async () => {
    const { client, manager, provision } = makeManager();
    const source = { kind: "s3", ref: { skillId: "skill_123" } };
    provision.seed(source, { "SKILL.md": "body" });
    vi.spyOn(provision, "project").mockRejectedValueOnce(
      new Error("Skill source unavailable"),
    );
    vi.spyOn(client, "destroy").mockRejectedValueOnce(
      new Error("gateway unavailable"),
    );
    const session = manager.open(
      specFor({ projections: [{ targetPath: "/skills/writer", source }] }),
    );
    await expect(session.readFile("/skills/writer/SKILL.md")).rejects.toThrow(
      /Skill source/,
    );
    expect(await session.readFile("/skills/writer/SKILL.md")).toBe("body");
  });
});
