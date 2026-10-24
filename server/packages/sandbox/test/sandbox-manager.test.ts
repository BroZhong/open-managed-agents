import { describe, it, expect, vi } from "vitest";
import type { ToolFileSystem } from "@open-managed-agents/adapter-core";
import {
  DefaultSandboxManager,
  SandboxSessionClosed,
  SandboxUnavailable,
  type SandboxPrepareOutcome,
  type EnvSpec,
  type SandboxEnvironmentBinding,
} from "../src/sandbox-manager.js";
import { FakeSandboxClient } from "../src/fake-sandbox-client.js";
import { INTENT_DEADLINE_SECONDS, SandboxCreateRejected } from "../src/sandbox-client.js";
import { isSkillInstallCommand, skillSetOf } from "../src/skill-install.js";
import type { SandboxLifecycleStore } from '@oma-server/store';
import { createMemoryStores } from "@oma-server/store-memory";
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
      claimReclamation: vi.fn(async () => ({ bindingId: 'root', ...binding.row(), now: new Date() })),
      completeReclamation: vi.fn(async () => { binding.write({ sandboxId: null, creatingSince: null }); }),
    };
    const manager = new DefaultSandboxManager({ sandboxClient: client, lifecycle: store, environment: "test" });
    const session = manager.open(specFor(), binding);
    await session.writeFile('saved.txt', 'persistent');
    expect(client.createOptsOf(client.created[0]).timeoutSeconds).toBe(86400);
    client.pause(binding.row().sandboxId!);
    const reconnect = vi.spyOn(client, 'reconnect');
    vi.spyOn(client, 'destroy').mockRejectedValueOnce(new Error('network unavailable'));
    await expect(manager.reclaim(binding)).rejects.toThrow('network');
    expect(store.completeReclamation).not.toHaveBeenCalled();
    expect(binding.row().sandboxId).not.toBeNull();
    expect(await manager.reclaim(binding)).toBe(true);
    expect(binding.row().sandboxId).toBeNull();
    expect(reconnect).not.toHaveBeenCalled();
    const replacement = manager.open(specFor(), binding);
    expect(await replacement.readFile('saved.txt')).toBe('persistent');
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
    expect(await manager.reclaim(binding)).toBe(false);
    expect(id()).toBe(original);
    expect(connect).not.toHaveBeenCalled();
    vi.spyOn(client, 'state').mockRejectedValueOnce(new Error('control plane timeout'));
    await expect(manager.reclaim(binding)).rejects.toThrow('timeout');
    expect(id()).toBe(original);
    client.reclaim(original);
    expect(await manager.reclaim(binding)).toBe(true);
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

  it("checks resource users inside the environment lock before reclaiming a parent's binding", async () => {
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
    expect(await manager.reclaim(binding)).toBe(false);
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
  });

  it("writes are shared immediately and survive reclamation and rebuilding", async () => {
    const { client, manager } = makeManager();
    const [bindingA, bindingB] = [durableBinding("a"), durableBinding("b")];
    const a = manager.open(specFor(), bindingA);
    const b = manager.open(specFor(), bindingB);
    await a.writeFile("中文 空格.txt", "saved by a");
    expect(await b.readFile("中文 空格.txt")).toBe("saved by a");
    await b.writeFile("other.txt", "saved by b");
    expect(await a.readFile("other.txt")).toBe("saved by b");
    const id = client.created[0];
    client.reclaim(id);
    await expect(a.readFile("中文 空格.txt")).rejects.toThrow(/not replayed/);
    expect(await a.readFile("中文 空格.txt")).toBe("saved by a");
    expect(await manager.reclaim(bindingA)).toBe(true);
    expect(await manager.reclaim(bindingB)).toBe(true);
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

  it("a missing mount or expired permissions blocks tools and reclamation still preserves saved files", async () => {
    const { client, manager } = makeManager();
    let terminated = false;
    const binding = { ...durableBinding(), canExecute: async () => !terminated };
    const session = manager.open(specFor(), binding);
    await session.writeFile("saved.txt", "already closed");
    const id = client.created[0];
    client.setMountFailure(id, "permission denied");
    await expect(
      session.writeFile("failed.txt", "must not exist"),
    ).rejects.toThrow(/unconfirmed/);
    await expect(session.checkWorkspace()).rejects.toThrow(/Workspace storage/);
    await expect(session.prepare()).rejects.toThrow(/Workspace storage/);
    terminated = true;
    expect(await manager.reclaim(binding)).toBe(true);
    expect(client.destroyed).toEqual([id]);
    const next = manager.open(specFor(), durableBinding("next"));
    expect(await next.readFile("saved.txt")).toBe("already closed");
    await expect(next.readFile("failed.txt")).rejects.toThrow(/no such file/);
    // The terminated Session's Turns run nothing more.
    await expect(
      manager.open(specFor(), binding).writeFile("after-termination", "x"),
    ).rejects.toBeInstanceOf(SandboxSessionClosed);
    expect(client.created).toHaveLength(2);
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

  it("pure chat preparation, availability checks and reclamation never create a Sandbox", async () => {
    const { client, manager } = makeManager();
    const binding = durableBinding();
    const session = manager.open(specFor(), binding);
    await session.prepare();
    await session.checkWorkspace();
    expect(await manager.reclaim(binding)).toBe(true);
    expect(await manager.reclaim(binding)).toBe(true);
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

  it("retries reclamation after a gateway failure without reopening execution", async () => {
    const { client, manager } = makeManager();
    let terminated = false;
    const binding = { ...durableBinding(), canExecute: async () => !terminated };
    await manager.open(specFor(), binding).writeFile("saved", "kept");
    terminated = true;
    vi.spyOn(client, "destroy").mockRejectedValueOnce(
      new Error("gateway unavailable"),
    );
    await expect(manager.reclaim(binding)).rejects.toThrow(/gateway unavailable/);
    await expect(manager.open(specFor(), binding).readFile("saved")).rejects.toBeInstanceOf(
      SandboxSessionClosed,
    );
    expect(await manager.reclaim(binding)).toBe(true);
    expect(client.destroyed).toHaveLength(1);
    expect(client.created).toHaveLength(1);
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

describe("each preparation of the Turn's environment is observed (ADR-0023, #287)", () => {
  /** A recorder of the session's preparations, in order. */
  function prepares() {
    const seen: Array<"started" | SandboxPrepareOutcome> = [];
    return { seen, observer: { started: () => { seen.push("started"); }, ended: (outcome: SandboxPrepareOutcome) => { seen.push(outcome); } } };
  }

  it("tells nothing of a Cold binding's Turn start; its first operation's create is one preparation, ready", async () => {
    const { client, manager } = makeManager();
    const session = manager.open(specFor(), durableBinding());
    const { seen, observer } = prepares();
    await session.prepare(undefined, { sandboxPrepares: observer });
    expect(seen).toEqual([]);
    await Promise.all([session.writeFile("a", "A"), session.writeFile("b", "B")]);
    expect(seen).toEqual(["started", { outcome: "ready", sandboxId: client.created[0] }]);
  });

  it("connects a Ready binding's Sandbox at Turn start, and defers to the first operation once its Sandbox is gone", async () => {
    const { client, manager } = makeManager();
    const binding = durableBinding();
    await manager.open(specFor(), binding).writeFile("saved.txt", "kept");
    const [first] = client.created;
    const ready = prepares();
    await manager.open(specFor(), binding).prepare(undefined, { sandboxPrepares: ready.observer });
    expect(ready.seen).toEqual(["started", { outcome: "ready", sandboxId: first }]);

    client.reclaim(first);
    const gone = prepares();
    const session = manager.open(specFor(), binding);
    await session.prepare(undefined, { sandboxPrepares: gone.observer });
    expect(gone.seen).toEqual(["started", { outcome: "deferred" }]);
    expect(await session.readFile("saved.txt")).toBe("kept");
    expect(gone.seen.slice(2)).toEqual(["started", { outcome: "ready", sandboxId: client.created[1] }]);
  });

  it("reports a failure of the gateway as sandbox_unavailable with a stable message, and the cause kept", async () => {
    const { client, manager } = makeManager();
    const binding = durableBinding();
    await manager.open(specFor(), binding).writeFile("saved.txt", "kept");
    vi.spyOn(client, "reconnect").mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.1:8080 token=secret"));
    const { seen, observer } = prepares();
    const session = manager.open(specFor(), binding);
    const prepared = session.prepare(undefined, { sandboxPrepares: observer });
    const failure = await session.readFile("saved.txt").catch((error: unknown) => error);
    await expect(prepared).rejects.toBe(failure);
    expect(failure).toBeInstanceOf(SandboxUnavailable);
    expect(failure).toMatchObject({ code: "sandbox_unavailable", reason: "unreachable",
      message: "The Session's Sandbox could not be reached. The tool was not executed; a later tool call can retry." });
    expect(String(failure)).not.toContain("secret");
    expect((failure as Error).cause).toEqual(new Error("connect ECONNREFUSED 10.0.0.1:8080 token=secret"));
    // The next operation prepares again.
    await expect(session.readFile("saved.txt")).rejects.toBeInstanceOf(SandboxUnavailable);
    expect(seen).toEqual(["started", { outcome: "failed", error: failure }, "started", { outcome: "failed", error: expect.any(SandboxUnavailable) }]);
  });

  it("ends a preparation the Turn stopped waiting for as aborted, which is no environment failure", async () => {
    const { manager } = makeManager();
    const clock = databaseClock();
    const binding = durableBinding("root", clock.now);
    // Another Turn's create is in flight.
    binding.write({ sandboxId: null, creatingSince: clock.now() });
    const { seen, observer } = prepares();
    const turn = new AbortController();
    const session = manager.open(specFor(), binding);
    await session.prepare(undefined, { signal: turn.signal, sandboxPrepares: observer });
    const waiting = session.writeFile("a.txt", "x");
    await settle();
    turn.abort(new DOMException("Session interrupted", "AbortError"));
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    expect(seen).toEqual(["started", { outcome: "aborted", reason: expect.objectContaining({ name: "AbortError" }) }]);
  });
});

describe("the binding keeps the last environment failure for the Session API (ADR-0023, #290)", () => {
  /** A binding kept by the in-memory store, as a Runner's sessions share it. */
  function storeBinding(id = "root") {
    const { delegationStore: store } = createMemoryStores();
    const binding: SandboxEnvironmentBinding = { id, withLock: (work) => store.withEnvironmentLock(id, work) };
    return { store, binding, environment: () => store.environment(id) };
  }
  const rejectCreates = (client: FakeSandboxClient) => {
    client.createFault = (step) => { if (step === "claim") throw new SandboxCreateRejected(403); };
  };

  it("records a rejected create with its code, reason and time, and clears it once a later tool creates the Sandbox", async () => {
    const { client, manager } = makeManager();
    const { binding, environment } = storeBinding();
    rejectCreates(client);
    const session = manager.open(specFor(), binding);
    await session.prepare();
    await expect(session.writeFile("a.txt", "x")).rejects.toMatchObject({ code: "sandbox_unavailable", reason: "rejected" });
    await settle();
    const failed = await environment();
    expect(failed).toEqual({ state: "unavailable", since: failed.lastError!.at,
      lastError: { code: "sandbox_unavailable", reason: "rejected", at: expect.any(Date) } });

    client.createFault = undefined;
    await session.writeFile("a.txt", "x");
    const recovered = await environment();
    expect(recovered).toMatchObject({ state: "ready", lastError: null });
    expect(recovered.since!.getTime()).toBeGreaterThanOrEqual(failed.lastError!.at.getTime());
  });

  it("records an unreachable Sandbox of a Ready binding, and the next Turn's connect clears it", async () => {
    const { client, manager } = makeManager();
    const { binding, environment } = storeBinding();
    await manager.open(specFor(), binding).writeFile("saved.txt", "kept");
    const ready = await environment();
    expect(ready).toMatchObject({ state: "ready", lastError: null });

    const reconnect = vi.spyOn(client, "reconnect").mockRejectedValue(new Error("connect ECONNREFUSED"));
    const session = manager.open(specFor(), binding);
    await expect(session.prepare()).rejects.toMatchObject({ reason: "unreachable" });
    await settle();
    expect(await environment()).toMatchObject({ state: "unavailable", lastError: { code: "sandbox_unavailable", reason: "unreachable" } });
    // A repeated failure: still unavailable since the first.
    const first = await environment();
    await expect(session.readFile("saved.txt")).rejects.toMatchObject({ reason: "unreachable" });
    await settle();
    expect(await environment()).toMatchObject({ state: "unavailable", since: first.since });

    reconnect.mockRestore();
    await manager.open(specFor(), binding).prepare();
    const recovered = await environment();
    expect(recovered).toMatchObject({ state: "ready", lastError: null });
    expect(recovered.since!.getTime()).toBeGreaterThanOrEqual(first.lastError!.at.getTime());
  });

  it("records a failed mount of a Sandbox it just created against that Sandbox", async () => {
    const { client, manager } = makeManager();
    const { binding, environment } = storeBinding();
    vi.spyOn(client, "verifyWorkspaceMount").mockRejectedValueOnce(new Error("mount missing"));
    await expect(manager.open(specFor(), binding).writeFile("a.txt", "x")).rejects.toMatchObject({ reason: "mount" });
    await settle();
    expect(await environment()).toMatchObject({ state: "unavailable", lastError: { reason: "mount" } });
    // The binding still records the Sandbox: the next tool retries its preparation, not its creation.
    expect(client.created).toHaveLength(1);
  });

  it("records no failure once another Runner moved the binding on: the failure is about a state that ended", async () => {
    const { client, manager } = makeManager();
    const { store, binding, environment } = storeBinding();
    // The creator's mount check is slow; meanwhile another Runner finds its Sandbox gone and returns the binding to Cold.
    let failMount!: () => void;
    vi.spyOn(client, "verifyWorkspaceMount").mockImplementationOnce(() => new Promise((_resolve, reject) => {
      failMount = () => reject(new Error("mount missing"));
    }));
    const writing = manager.open(specFor(), binding).writeFile("a.txt", "x");
    await vi.waitFor(() => expect(failMount).toBeDefined());
    await store.withEnvironmentLock("root", async () => ({ next: "cold", value: undefined }));
    const cold = await environment();
    failMount();
    await expect(writing).rejects.toMatchObject({ reason: "mount" });
    await settle();
    expect(await environment()).toEqual(cold);
    expect(cold).toMatchObject({ state: "cold", lastError: null });
  });

  it("records nothing for a preparation the Turn stopped waiting for", async () => {
    const { manager } = makeManager();
    const { store, binding, environment } = storeBinding();
    // Another Turn's create is in flight.
    await store.withEnvironmentLock("root", async () => ({ next: "creating", value: undefined }));
    const creating = await environment();
    const turn = new AbortController();
    const session = manager.open(specFor(), binding);
    await session.prepare(undefined, { signal: turn.signal });
    const waiting = session.writeFile("a.txt", "x");
    await settle();
    turn.abort(new DOMException("Session interrupted", "AbortError"));
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    await settle();
    expect(await environment()).toEqual(creating);
    expect(creating.state).toBe("creating");
  });
});
