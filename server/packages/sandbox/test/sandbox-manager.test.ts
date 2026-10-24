import { describe, it, expect, vi } from "vitest";
import type { ToolFileSystem } from "@open-managed-agents/adapter-core";
import {
  DefaultSandboxManager,
  SandboxSessionClosed,
  SandboxUnavailable,
  type EnvSpec,
  type SandboxEnvironmentBinding,
} from "../src/sandbox-manager.js";
import { FakeSandboxClient } from "../src/fake-sandbox-client.js";
import { INTENT_DEADLINE_SECONDS, SandboxCreateRejected } from "../src/sandbox-client.js";
import { isSkillInstallCommand, skillSetOf } from "../src/skill-install.js";
import type { SandboxLifecycleStore } from '@oma-server/store';
import { Bundles, text } from "./skill-bundles.js";
import { databaseClock, durableBinding } from "./bindings.js";

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
  const bundles = new Bundles();
  const manager = new DefaultSandboxManager({ sandboxClient: client, skillBundleStore: bundles, environment: "test" });
  const exec = vi.spyOn(client, "exec");
  const installs = () => exec.mock.calls.filter(([, command]) => isSkillInstallCommand(command)).length;
  return { client, bundles, manager, installs };
}

describe("mounted Workspace Sandbox Manager", () => {
  it('retries explicit deletion without resuming and clears the binding only after confirmation', async () => {
    const client = new FakeSandboxClient();
    const binding = durableBinding('root');
    const store: SandboxLifecycleStore = {
      begin: vi.fn(async () => true), finish: vi.fn(async () => {}),
      claimReclamation: vi.fn(async () => { const { sandboxId } = binding.row(); return sandboxId ? { bindingId: 'root', sandboxId } : null; }),
      completeReclamation: vi.fn(async () => { binding.write({ sandboxId: null, creatingSince: null }); }),
    };
    const manager = new DefaultSandboxManager({ sandboxClient: client, lifecycle: store, environment: "test" });
    const session = manager.open(specFor(), binding);
    await session.writeFile('saved.txt', 'persistent');
    expect(client.createOptsOf(client.created[0]).timeoutSeconds).toBe(86400);
    client.pause(binding.row().sandboxId!);
    const reconnect = vi.spyOn(client, 'reconnect');
    vi.spyOn(client, 'destroy').mockRejectedValueOnce(new Error('network unavailable'));
    await expect(session.dispose()).rejects.toThrow('network');
    expect(store.completeReclamation).not.toHaveBeenCalled();
    expect(binding.row().sandboxId).not.toBeNull();
    await session.dispose();
    expect(binding.row().sandboxId).toBeNull();
    expect(reconnect).not.toHaveBeenCalled();
    const replacement = manager.open(specFor(), binding);
    expect(await replacement.readFile('saved.txt')).toBe('persistent');
  });
  it('does not bypass binding coordination through reclaim()', async () => {
    const { client } = makeManager();
    const store: SandboxLifecycleStore = {
      begin: vi.fn(async () => true), finish: vi.fn(async () => {}),
      claimReclamation: vi.fn(async () => { throw new Error('database unavailable'); }),
      completeReclamation: vi.fn(async () => {}),
    };
    const manager = new DefaultSandboxManager({ sandboxClient: client, lifecycle: store, environment: "test" });
    await expect(manager.reclaim('arbitrary')).rejects.toThrow('ticket');
    expect(client.destroyed).toEqual([]);
  });
  it('preserves shared users but clears their obsolete pointer only on confirmed native deletion', async () => {
    const { client } = makeManager();
    const store: SandboxLifecycleStore = {
      begin: vi.fn(async () => true), finish: vi.fn(async () => {}),
      claimReclamation: vi.fn(async () => null), completeReclamation: vi.fn(async () => {}),
    };
    const manager = new DefaultSandboxManager({ sandboxClient: client, lifecycle: store, environment: "test" });
    const binding = durableBinding('shared');
    const id = () => binding.row().sandboxId;
    const parent = manager.open(specFor(), binding);
    await parent.writeFile('saved', 'value');
    const original = id()!;
    client.pause(original);
    const connect = vi.spyOn(client, 'reconnect');
    await parent.dispose();
    expect(id()).toBe(original);
    expect(connect).not.toHaveBeenCalled();
    const cleanup = manager.open(specFor(), binding);
    vi.spyOn(client, 'state').mockRejectedValueOnce(new Error('control plane timeout'));
    await expect(cleanup.dispose()).rejects.toThrow('timeout');
    expect(id()).toBe(original);
    client.reclaim(original);
    await cleanup.dispose();
    expect(id()).toBeNull();
    expect(client.destroyed).toEqual([]);
    expect(store.completeReclamation).not.toHaveBeenCalled();
  });
  it("installs renamed Skills after a new Host attaches to a shared environment", async () => {
    const { client, bundles, manager } = makeManager();
    const binding = durableBinding();
    const old = await bundles.add("old-name", [text("SKILL.md", "old body")]);
    const first = manager.open(specFor({ skills: skillSetOf([old]) }), binding);
    expect(await first.readFile("/skills/old-name/SKILL.md")).toBe("old body");
    const edited = await bundles.add("new-name", [text("SKILL.md", "new body")]);
    const resumed = manager.open(specFor(), binding);
    await resumed.prepare(skillSetOf([edited]));
    expect(await resumed.readFile("/skills/new-name/SKILL.md")).toBe("new body");
    await expect(resumed.readFile("/skills/old-name/SKILL.md")).rejects.toThrow();
    expect(client.created).toHaveLength(1);
    expect(binding.installed()).toEqual({ sandboxId: client.created[0], setHash: skillSetOf([edited]).setHash, generation: 2 });
  });

  it("skips an unchanged Skill Set for later Turns and for every session sharing the binding", async () => {
    const { client, bundles, manager, installs } = makeManager();
    const binding = durableBinding();
    const skills = skillSetOf([await bundles.add("writer", [text("SKILL.md", "body")])]);
    const parent = manager.open(specFor({ skills }), binding);
    await parent.writeFile("saved.txt", "kept");
    expect(installs()).toBe(1);
    const signed = bundles.signed.length;
    await parent.prepare(skills);
    const child = manager.open(specFor({ skills }), binding);
    await child.prepare(skills);
    expect(await child.readFile("/skills/writer/SKILL.md")).toBe("body");
    expect(installs()).toBe(1);
    expect(bundles.signed).toHaveLength(signed);
    expect(client.created).toHaveLength(1);
  });

  it("installs the empty Skill Set over a projected /skills directory once, then skips it", async () => {
    const { client, manager, installs } = makeManager();
    const binding = durableBinding();
    const first = manager.open(specFor(), binding);
    await first.writeFile("existing.txt", "kept");
    const id = client.created[0];
    // A Sandbox prepared before Skill Install: projected files and no record.
    client.seedProjectedSkills(id, { "/skills/projected/SKILL.md": "legacy" });
    binding.forgetSkills();
    const resumed = manager.open(specFor(), binding);
    await resumed.prepare();
    // The install runs beside the Turn; its first operation waits for it.
    expect(await resumed.readFile("existing.txt")).toBe("kept");
    expect(client.filesOf(id).has("/skills/projected/SKILL.md")).toBe(false);
    const before = installs();
    await resumed.prepare();
    expect(installs()).toBe(before);
    expect(client.created).toHaveLength(1);
  });

  it("fails the Turn's operations with the install's stage and keeps the Sandbox for the next Turn", async () => {
    const { client, bundles, manager } = makeManager();
    const binding = durableBinding();
    const session = manager.open(specFor(), binding);
    await session.writeFile("saved.txt", "kept");
    const skills = skillSetOf([await bundles.add("writer", [text("SKILL.md", "body")])]);
    client.skillInstallFault = (stage) => { if (stage === "download") throw new Error("connection reset"); };
    await session.prepare(skills);
    await expect(session.readFile("saved.txt")).rejects.toMatchObject({ name: "SkillInstallError", stage: "download", message: expect.stringContaining("connection reset") });
    expect(binding.installed()?.setHash).not.toBe(skills.setHash);
    client.skillInstallFault = undefined;
    await session.prepare(skills);
    expect(await session.readFile("/skills/writer/SKILL.md")).toBe("body");
    expect(client.created).toHaveLength(1);
  });

  it("checks resource users inside the environment lock before disposing a parent", async () => {
    const { client, manager } = makeManager();
    const durable = durableBinding();
    let insideLock = false;
    const binding: SandboxEnvironmentBinding = {
      id: durable.id,
      withLock: async (work) => {
        insideLock = true;
        try { return await durable.withLock(work); }
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
  it("verifies preparation, reports native failures without replay and keeps the capability stable after rebuild", async () => {
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
    const session = manager.open(specFor(), durableBinding());
    const capability = session.fileSystem;
    await capability.writeFile("native.bin", new Uint8Array([0, 255]));
    expect(await capability.readFile("native.bin")).toEqual(new Uint8Array([0, 255]));
    expect(nativeRead.mock.calls[0][1]).toBe("/home/user/workspace/native.bin");
    const first = client.created[0];
    client.setMountFailure(first, "credential unavailable");
    await expect(capability.writeFile("blocked.bin", new Uint8Array())).rejects.toThrow(/unconfirmed/);
    expect(nativeWrite).toHaveBeenCalledTimes(2);
    client.reclaim(first);
    expect(await capability.readFile("native.bin")).toEqual(new Uint8Array([0, 255]));
    expect(session.fileSystem).toBe(capability);
    expect(client.created).toHaveLength(2);
    expect(nativeRead.mock.calls.at(-1)?.[0]).toBe(client.created[1]);
    await session.dispose();
  });

  it("writes are shared immediately and survive disposal and rebuilding", async () => {
    const { client, manager } = makeManager();
    const a = manager.open(specFor(), durableBinding("a"));
    const b = manager.open(specFor(), durableBinding("b"));
    await a.writeFile("中文 空格.txt", "saved by a");
    expect(await b.readFile("中文 空格.txt")).toBe("saved by a");
    await b.writeFile("other.txt", "saved by b");
    expect(await a.readFile("other.txt")).toBe("saved by b");
    const id = client.created[0];
    client.reclaim(id);
    await expect(a.readFile("中文 空格.txt")).rejects.toThrow(/not replayed/);
    expect(await a.readFile("中文 空格.txt")).toBe("saved by a");
    await a.dispose();
    await b.dispose();
    const rebuilt = manager.open(specFor(), durableBinding("c"));
    expect(await rebuilt.readFile("other.txt")).toBe("saved by b");
  });
  it("requests the exact trusted CSI prefix and rejects another Workspace before creating", async () => {
    const { client, manager } = makeManager();
    const session = manager.open(specFor(), durableBinding("sesn_root"));
    await session.writeFile("a", "saved");
    expect(client.createOptsOf(client.created[0]).metadata).toEqual({
      "oma.dev/binding": "sesn_root",
      "oma.dev/environment": "test",
      "oma.dev/tenant": "tenant_1",
      "oma.dev/workspace": "ws_1",
      "security.agents.kruise.io/agent-name": "agentry-workspace",
      "e2b.agents.kruise.io/csi-volume-config":
        '[{"pvName":"agentry-workspace-oss","mountPath":"/home/user/workspace","subPath":"tenant_1/ws_1","attributes":{"credentialProviderName":"agentry-oss-rw"}}]',
    });
    expect(() =>
      manager.open(
        specFor({ workspaceMount: { ...mount, prefix: "other/ws_1/" } }),
        durableBinding(),
      ),
    ).toThrow(/prefix/);
    expect(client.created).toHaveLength(1);
  });

  it("a missing mount or expired permissions blocks tools and disposal still preserves saved files", async () => {
    const { client, manager } = makeManager();
    const session = manager.open(specFor(), durableBinding());
    await session.writeFile("saved.txt", "already closed");
    const id = client.created[0];
    client.setMountFailure(id, "permission denied");
    await expect(
      session.writeFile("failed.txt", "must not exist"),
    ).rejects.toThrow(/unconfirmed/);
    await expect(session.checkWorkspace()).rejects.toThrow(/Workspace storage/);
    await expect(session.prepare()).rejects.toThrow(/Workspace storage/);
    await session.dispose();
    expect(client.destroyed).toEqual([id]);
    const next = manager.open(specFor(), durableBinding("next"));
    expect(await next.readFile("saved.txt")).toBe("already closed");
    await expect(next.readFile("failed.txt")).rejects.toThrow(/no such file/);
    await expect(
      session.writeFile("after-dispose", "x"),
    ).rejects.toBeInstanceOf(SandboxSessionClosed);
  });

  it("a wrong mounted prefix blocks reads until the same mount recovers", async () => {
    const { client, manager } = makeManager();
    const session = manager.open(specFor(), durableBinding());
    await session.writeFile("saved.txt", "saved");
    const id = client.created[0];
    client.setMountIdentity(id, {
      mountPath: "/home/user/workspace",
      bucket: "agentry",
      prefix: "tenant_1/other/",
    });
    await expect(session.prepare()).rejects.toThrow(/Workspace storage/);
    client.setMountIdentity(id, {
      mountPath: "/home/user/workspace",
      bucket: "agentry",
      prefix: "tenant_1/ws_1/",
    });
    expect(await session.readFile("saved.txt")).toBe("saved");
    expect(client.created).toHaveLength(1);
  });

  it("retains known failed provisioning and retries preparation without duplicate creation", async () => {
    const { client, manager } = makeManager();
    vi.spyOn(client, "verifyWorkspaceMount").mockRejectedValueOnce(
      new Error("secret provider detail"),
    );
    const session = manager.open(specFor(), durableBinding());
    await expect(session.writeFile("a.txt", "first")).rejects.toThrow(
      /Workspace storage/,
    );
    expect(client.destroyed).toEqual([]);
    await session.writeFile("a.txt", "retry");
    expect(await session.readFile("a.txt")).toBe("retry");
    expect(client.created).toHaveLength(1);
  });

  it("installs renamed Skills by name, and reinstalls them on a rebuilt Sandbox", async () => {
    const { client, manager, bundles } = makeManager();
    const writer = await bundles.add("writer", [text("SKILL.md", "v1"), text("old.txt", "obsolete")]);
    const session = manager.open(specFor({ skills: skillSetOf([writer]) }), durableBinding());
    expect(await session.readFile("/skills/writer/SKILL.md")).toBe("v1");
    await session.writeFile("data.txt", "workspace");
    const id = client.created[0];
    await client.writeFile(
      id,
      "/home/user/.local/cache.txt",
      "local dependency",
    );
    const editor = await bundles.add("editor", [text("SKILL.md", "v2")]);
    await session.prepare(skillSetOf([editor]));
    expect(await session.readFile("/skills/editor/SKILL.md")).toBe("v2");
    await expect(session.readFile("/skills/writer/SKILL.md")).rejects.toThrow();
    expect((await session.list()).map((entry) => entry.path)).toEqual([
      "data.txt",
    ]);
    expect(await session.readFile("/home/user/.local/cache.txt")).toBe(
      "local dependency",
    );
    client.reclaim(id);
    await expect(session.readFile("/skills/editor/SKILL.md")).rejects.toThrow(/not replayed/);
    expect(await session.readFile("/skills/editor/SKILL.md")).toBe("v2");
    expect(await session.readFile("data.txt")).toBe("workspace");
    await expect(
      session.readFile("/home/user/.local/cache.txt"),
    ).rejects.toThrow();
  });

  it("keeps another Workspace isolated while same-Workspace overwrites remain last-close wins", async () => {
    const { manager } = makeManager();
    const a = manager.open(specFor(), durableBinding("a"));
    const b = manager.open(specFor(), durableBinding("b"));
    const other = manager.open(
      specFor({
        workspaceId: "ws_2",
        workspaceMount: { ...mount, prefix: "tenant_1/ws_2/" },
      }),
      durableBinding("other"),
    );
    await a.writeFile("a.txt", "one");
    await b.writeFile("a.txt", "two");
    await other.writeFile("a.txt", "other");
    expect(await a.readFile("a.txt")).toBe("two");
    expect(await other.readFile("a.txt")).toBe("other");
  });

  it.each(["mount check", "download", "extract", "switch"])("keeps the old Skills when a failed %s is retried after another rename", async (failure) => {
    const { client, manager, bundles } = makeManager();
    const original = await bundles.add("writer", [text("SKILL.md", "original")]);
    const session = manager.open(specFor({ skills: skillSetOf([original]) }), durableBinding());
    expect(await session.readFile("/skills/writer/SKILL.md")).toBe("original");
    const id = client.created[0];
    const files = [text("SKILL.md", "renamed"), text("helper.txt", "helper")];
    if (failure === "mount check") client.setMountFailure(id, "storage offline");
    else client.skillInstallFault = (stage) => { if (stage === failure) throw new Error(`${failure} unavailable`); };
    // A mount check fails preparation; an install fails the Turn's first operation.
    await expect(session.prepare(skillSetOf([await bundles.add("editor", files)])).then(() => session.readFile("data.txt"))).rejects.toThrow();
    client.setMountFailure(id);
    client.skillInstallFault = undefined;
    // Never a half-installed tree: the old version stays until a switch.
    expect(await client.readFile(id, "/skills/writer/SKILL.md")).toBe("original");
    expect(client.filesOf(id).has("/skills/editor/SKILL.md")).toBe(false);
    await session.prepare(skillSetOf([await bundles.add("final-name", files)]));
    expect(await session.readFile("/skills/final-name/SKILL.md")).toBe("renamed");
    await expect(session.readFile("/skills/writer/SKILL.md")).rejects.toThrow(/no such file/);
    await expect(session.readFile("/skills/editor/SKILL.md")).rejects.toThrow(/no such file/);
    expect(client.created).toHaveLength(1);
  });

  it("pure chat preparation, availability checks and disposal never create a Sandbox", async () => {
    const { client, manager } = makeManager();
    const session = manager.open(specFor(), durableBinding());
    await session.prepare();
    await session.checkWorkspace();
    await session.dispose();
    await session.dispose();
    expect(client.created).toEqual([]);
    expect(client.destroyed).toEqual([]);
  });

  it("concurrent tool calls share one create and keep cwd, env, timeout and Interrupt signal", async () => {
    const { client, manager } = makeManager();
    const session = manager.open(specFor(), durableBinding());
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
      onExit: expect.any(Function),
    });
  });

  it("retries disposal after a gateway failure without reopening execution", async () => {
    const { client, manager } = makeManager();
    const session = manager.open(specFor(), durableBinding());
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

  it("keeps a new Sandbox whose first install failed and installs on the next tool call", async () => {
    const { client, manager, bundles } = makeManager();
    const skills = skillSetOf([await bundles.add("writer", [text("SKILL.md", "body")])]);
    client.skillInstallFault = (stage) => { if (stage === "download") throw new Error("Skill source unavailable"); };
    const session = manager.open(specFor({ skills }), durableBinding());
    await expect(session.readFile("/skills/writer/SKILL.md")).rejects.toThrow(/Skill Install failed at download: Skill source unavailable/);
    expect(client.created).toHaveLength(1);
    expect(client.filesOf(client.created[0]).has("/skills/writer/SKILL.md")).toBe(false);
    client.skillInstallFault = undefined;
    expect(await session.readFile("/skills/writer/SKILL.md")).toBe("body");
    expect(client.created).toHaveLength(1);
  });

  it("returns to Cold only the intent its rejected create was committed with, never another Runner's", async () => {
    const { client, manager } = makeManager();
    const clock = databaseClock();
    const binding = durableBinding("root", clock.now);
    // Stalled past its deadline, the create is superseded: another Runner reconciled and committed a fresh intent.
    const fresh = { sandboxId: null, creatingSince: new Date(clock.now().getTime() + INTENT_DEADLINE_SECONDS * 1000) };
    client.createFault = (step) => {
      if (step !== "claim") return;
      clock.elapse(INTENT_DEADLINE_SECONDS);
      binding.write(fresh);
      throw new SandboxCreateRejected(409);
    };
    const failure = await manager.open(specFor(), binding).writeFile("a.txt", "x").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SandboxUnavailable);
    expect(failure).toMatchObject({ reason: "rejected", status: 409 });
    expect(binding.row()).toBe(fresh);
  });
});

/** A promise the test settles. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => { resolve = settle; });
  return { promise, resolve };
}

/** Let pending callbacks run. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

describe("a Turn's Skill Install runs beside the Turn (#268)", () => {
  /** A bound session whose Sandbox exists and holds the empty Skill Set. */
  async function warm() {
    const fixture = makeManager();
    const binding = durableBinding();
    const session = fixture.manager.open(specFor(), binding);
    await session.writeFile("saved.txt", "kept");
    const id = fixture.client.created[0];
    const exec = vi.mocked(fixture.client.exec);
    /** What reached the Sandbox besides installs: the Turn's own operations. */
    const business = () => exec.mock.calls.filter(([, command]) => !isSkillInstallCommand(command)).length
      + readFile.mock.calls.length + nativeCalls.length;
    const readFile = vi.spyOn(fixture.client, "readFile");
    // Native filesystem primitives over the fake's files, counted.
    const nativeCalls: string[] = [];
    const native = (name: string, work: () => Promise<unknown>) => { nativeCalls.push(name); return work(); };
    const unavailable = () => { throw new Error("Unexpected filesystem operation"); };
    Object.assign(fixture.client, { fileSystem: (sandboxId: string): ToolFileSystem => ({
      stat: (path) => native("stat", async () => ({ isFile: fixture.client.filesOf(sandboxId).has(path), isDirectory: false, isSymbolicLink: false, size: 0, mtimeMs: 0 })),
      createTempFile: () => native("createTempFile", async () => "/tmp/request.json"),
      readFile: unavailable, writeFile: unavailable, appendFile: unavailable, access: unavailable,
      lstat: unavailable, realpath: unavailable, readdir: unavailable, mkdir: unavailable,
    }) as ToolFileSystem });
    const observer = { started: vi.fn(), ended: vi.fn() };
    return { ...fixture, binding, session, id, business, observer, before: business() };
  }

  it("resolves prepare once the mount is verified; every kind of operation waits for the install before it runs", async () => {
    const { client, bundles, session, binding, observer, business } = await warm();
    const skills = skillSetOf([await bundles.add("writer", [text("SKILL.md", "v1")])]);
    const download = deferred();
    client.skillInstallFault = (stage) => stage === "download" ? download.promise : undefined;
    const ran = business();
    await session.prepare(skills, { skillInstalls: observer });
    expect(observer.started).toHaveBeenCalledExactlyOnceWith(skills);
    const read = session.readFile("/skills/writer/SKILL.md");
    const stat = session.fileSystem.stat("/skills/writer/SKILL.md");
    const exec = (async () => { for await (const _ of session.exec(["echo", "hi"])) { /* drain */ } })();
    await settle();
    expect(business()).toBe(ran);
    expect(observer.ended).not.toHaveBeenCalled();
    download.resolve();
    expect(await read).toBe("v1");
    expect(await stat).toMatchObject({ isFile: true });
    await exec;
    expect(observer.ended).toHaveBeenCalledExactlyOnceWith({ report: expect.objectContaining({ downloaded: 1, skills: 1 }) });
    expect(binding.installed()?.setHash).toBe(skills.setHash);
  });

  it("fails every operation of the Turn with the install's error without running it; the next Turn installs again", async () => {
    const { client, bundles, session, binding, observer, business, installs } = await warm();
    const skills = skillSetOf([await bundles.add("writer", [text("SKILL.md", "v1")])]);
    client.skillInstallFault = (stage) => { if (stage === "download") throw new Error("HTTP 503"); };
    const ran = business();
    await session.prepare(skills, { skillInstalls: observer });
    await expect(session.readFile("saved.txt")).rejects.toMatchObject({ name: "SkillInstallError", stage: "download" });
    await expect(session.fileSystem.createTempFile()).rejects.toMatchObject({ name: "SkillInstallError", stage: "download" });
    const attempts = installs();
    expect(business()).toBe(ran);
    expect(observer.ended).toHaveBeenCalledExactlyOnceWith({ error: expect.objectContaining({ name: "SkillInstallError", stage: "download" }) });
    expect(binding.installed()?.setHash).not.toBe(skills.setHash);
    client.skillInstallFault = undefined;
    await session.prepare(skills);
    expect(installs()).toBe(attempts + 1);
    expect(await session.readFile("/skills/writer/SKILL.md")).toBe("v1");
  });

  it("prepares a skipped install before prepare resolves and tells the observer nothing", async () => {
    const { session, observer, installs } = await warm();
    const before = installs();
    await session.prepare(undefined, { skillInstalls: observer });
    expect(await session.readFile("saved.txt")).toBe("kept");
    expect(installs()).toBe(before);
    expect(observer.started).not.toHaveBeenCalled();
    expect(observer.ended).not.toHaveBeenCalled();
  });

  it("cancels the install when the Turn's signal aborts: operations reject with its reason and nothing is recorded", async () => {
    const { client, bundles, session, binding, observer, business } = await warm();
    const skills = skillSetOf([await bundles.add("writer", [text("SKILL.md", "v1")])]);
    client.skillInstallFault = (stage, signal) => stage === "download"
      ? new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve())) : undefined;
    const turn = new AbortController();
    const ran = business();
    await session.prepare(skills, { signal: turn.signal, skillInstalls: observer });
    const read = session.readFile("saved.txt");
    await settle();
    turn.abort(new DOMException("Session interrupted", "AbortError"));
    await expect(read).rejects.toMatchObject({ name: "AbortError", message: "Session interrupted" });
    expect(business()).toBe(ran);
    expect(observer.ended).toHaveBeenCalledExactlyOnceWith({ error: expect.objectContaining({ name: "AbortError" }) });
    expect(binding.installed()?.setHash).not.toBe(skills.setHash);
    client.skillInstallFault = undefined;
    await session.prepare(skills);
    expect(await session.readFile("/skills/writer/SKILL.md")).toBe("v1");
  });

  it("tells the observer of the install a cold Sandbox runs before its first operation", async () => {
    const { manager, client, bundles } = makeManager();
    const skills = skillSetOf([await bundles.add("writer", [text("SKILL.md", "v1")])]);
    const session = manager.open(specFor({ skills }), durableBinding());
    const observer = { started: vi.fn(), ended: vi.fn() };
    await session.prepare(skills, { skillInstalls: observer });
    expect(client.created).toHaveLength(0);
    expect(observer.started).not.toHaveBeenCalled();
    expect(await session.readFile("/skills/writer/SKILL.md")).toBe("v1");
    expect(observer.started).toHaveBeenCalledExactlyOnceWith(skills);
    expect(observer.ended).toHaveBeenCalledExactlyOnceWith({ report: expect.objectContaining({ downloaded: 1 }) });
  });
});
