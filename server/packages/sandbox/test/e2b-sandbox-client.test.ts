import { afterEach, describe, it, expect, vi } from "vitest";
import { ExecAbortedBeforeStartError } from "@open-managed-agents/adapter-core";
import { Sandbox, SandboxNotFoundError } from 'e2b';
import {
  E2BSandboxClient,
  parseFindOutput,
  resolveTemplate,
  type CreateSandboxFn,
  type E2BSandbox,
  type E2BCommandResult,
  type E2BCommandHandle,
} from "../src/e2b-sandbox-client.js";
import type { SandboxExecChunk } from "../src/sandbox-client.js";
import { CLAIM_SECONDS, CREATE_REQUEST_MS, INTENT_DEADLINE_SECONDS, SandboxCreateRejected, WAIT_READY_SECONDS } from "../src/index.js";

/** A recorded `commands.run` call. */
interface RunCall {
  cmd: string;
  opts?: {
    user?: string;
    cwd?: string;
    envs?: Record<string, string>;
    timeoutMs?: number;
    signal?: AbortSignal;
    background?: boolean;
    stdin?: boolean;
    onStdout?: (data: string) => void | Promise<void>;
    onStderr?: (data: string) => void | Promise<void>;
    onStdoutBytes?: (data: Uint8Array) => void | Promise<void>;
    onStderrBytes?: (data: Uint8Array) => void | Promise<void>;
  };
}

/**
 * A hand-rolled fake e2b Sandbox. `runHandler` decides output + exit for each
 * command; if it returns undefined the command is a no-op success (exit 0).
 */
class FakeSandbox implements E2BSandbox {
  readonly sandboxId: string;
  readonly runCalls: RunCall[] = [];
  readonly writes: Array<{ path: string; data: string | ArrayBuffer }> = [];
  readonly removes: string[] = [];
  readonly reads = new Map<string, string | Uint8Array>();
  killed = false;
  running = true;
  metadata: Record<string, string> = {};
  async getInfo() {
    return { metadata: this.metadata };
  }
  /** When set, isRunning throws (simulates a not-found/transport error). */
  isRunningThrows = false;
  backgroundStart?: () => Promise<void>;
  processWait?: () => Promise<E2BCommandResult>;
  processKill = vi.fn(async () => true);
  processDisconnect = vi.fn(async () => {});
  readonly stdinWrites: Array<{ pid: number; data: string | Uint8Array }> = [];
  sendStdin = vi.fn(async (pid: number, data: string | Uint8Array) => { this.stdinWrites.push({ pid, data }); });
  private runHandler?: (
    cmd: string,
  ) =>
    | {
        stdout?: string;
        stderr?: string;
        exitCode?: number;
        throwExit?: boolean;
      }
    | undefined;

  constructor(id: string, runHandler?: FakeSandbox["runHandler"]) {
    this.sandboxId = id;
    this.runHandler = runHandler;
  }

  commands = {
    run: (async (
      cmd: string,
      opts?: RunCall["opts"],
    ): Promise<E2BCommandResult | E2BCommandHandle> => {
      this.runCalls.push({ cmd, opts });
      const wait = async () => {
        if (this.processWait) return this.processWait();
        const r = this.runHandler?.(cmd) ?? {};
        if (r.stdout && opts?.onStdout) await opts.onStdout(r.stdout);
        if (r.stderr && opts?.onStderr) await opts.onStderr(r.stderr);
        const exitCode = r.exitCode ?? 0;
        if (r.throwExit) {
          // Mimic CommandExitError: an object carrying a numeric exitCode.
          throw { exitCode, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
        }
        return { exitCode, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
      };
      if (opts?.background) {
        await this.backgroundStart?.();
        return { pid: 4242, wait, kill: this.processKill, disconnect: this.processDisconnect };
      }
      return wait();
    }) as E2BSandbox["commands"]["run"],
    sendStdin: (pid: number, data: string | Uint8Array) => this.sendStdin(pid, data),
  };

  files = {
    read: async (
      path: string,
      opts?: { format?: "text" | "bytes" },
    ): Promise<string | Uint8Array> => {
      const body = this.reads.get(path);
      if (body === undefined) throw new Error(`no such file ${path}`);
      if (opts?.format === "bytes") {
        return typeof body === "string" ? new TextEncoder().encode(body) : body;
      }
      return typeof body === "string" ? body : new TextDecoder().decode(body);
    },
    write: async (
      path: string,
      data: string | ArrayBuffer,
    ): Promise<unknown> => {
      this.writes.push({ path, data });
      this.reads.set(
        path,
        typeof data === "string" ? data : new Uint8Array(data),
      );
      return { path };
    },
    remove: async (path: string): Promise<void> => {
      this.removes.push(path);
      const base = path.replace(/\/+$/, "");
      for (const candidate of [...this.reads.keys()]) {
        if (candidate === base || candidate.startsWith(`${base}/`)) {
          this.reads.delete(candidate);
        }
      }
    },
  } as E2BSandbox["files"];

  async isRunning(): Promise<boolean> {
    if (this.isRunningThrows) throw new Error("sandbox not found");
    return this.running;
  }

  async kill(): Promise<void> {
    this.killed = true;
  }
}

/** Build a client wired to a fake factory; expose the created sandboxes. */
function makeClient(
  runHandler?: FakeSandbox["runHandler"],
  opts?: {
    failKill?: boolean;
    verifyWorkspaceProbe?: (
      target: unknown,
      name: string,
      body: string,
    ) => Promise<void>;
  },
): {
  client: E2BSandboxClient;
  factoryCalls: Array<{
    template: string;
    opts: Parameters<CreateSandboxFn>[1];
  }>;
  sandboxes: FakeSandbox[];
} {
  const factoryCalls: Array<{
    template: string;
    opts: Parameters<CreateSandboxFn>[1];
  }> = [];
  const sandboxes: FakeSandbox[] = [];
  let counter = 0;
  const createSandbox: CreateSandboxFn = async (template, o) => {
    factoryCalls.push({ template, opts: o });
    const s = new FakeSandbox(`sbx-${++counter}`, runHandler);
    const volume = JSON.parse(
      o.metadata?.["e2b.agents.kruise.io/csi-volume-config"] ?? "null",
    )?.[0];
    if (volume)
      s.metadata = {
        "security.agents.kruise.io/agent-name":
          o.metadata!["security.agents.kruise.io/agent-name"],
        "security.agents.kruise.io/storage-auth": JSON.stringify([
          {
            credentialProviderName: volume.attributes.credentialProviderName,
            attributes: {
              "bucket-name": "agentry",
              "sub-path": volume.subPath,
            },
          },
        ]),
      };
    if (opts?.failKill) {
      s.kill = async () => {
        throw new SandboxNotFoundError("not found");
      };
    }
    sandboxes.push(s);
    return s;
  };
  const client = new E2BSandboxClient({
    domain: "sandbox.example.com",
    apiKey: "gw-key",
    defaultTemplate: "configured-template",
    createSandbox,
    getSandboxInfo: async id => {
      const sandbox = sandboxes.find(item => item.sandboxId === id);
      if (!sandbox || sandbox.killed) throw new SandboxNotFoundError('not found');
      if (sandbox.isRunningThrows) throw new Error('network unavailable');
      return { state: sandbox.running ? 'running' : 'paused' };
    },
    killSandbox: async id => { await sandboxes.find(item => item.sandboxId === id)?.kill(); },
    setSandboxTimeout: async () => {},
    verifyWorkspaceProbe: opts?.verifyWorkspaceProbe ?? (async () => {}),
  });
  return { client, factoryCalls, sandboxes };
}

describe("root commands with input on stdin", () => {
  it("runs as root and sends the input once to the started process, never on its command line", async () => {
    const { client, sandboxes } = makeClient(() => ({ stdout: "done\n" }));
    const { id } = await client.create();
    const onExit = vi.fn();
    const secret = "https://bucket.example.com/key.zip?Signature=abc\n";
    const chunks = await collect(client.exec(id, ["bash", "-c", "read -r line"], { user: "root", stdin: secret, timeoutSeconds: 40, onExit }));
    expect(chunks.map((chunk) => chunk.text).join("")).toBe("done\n");
    const call = sandboxes[0].runCalls.at(-1)!;
    expect(call.opts).toMatchObject({ user: "root", stdin: true, background: true, timeoutMs: 40_000 });
    expect(call.cmd).not.toContain("Signature");
    expect(JSON.stringify(call.opts)).not.toContain("Signature");
    expect(sandboxes[0].stdinWrites).toEqual([{ pid: 4242, data: secret }]);
    expect(onExit).toHaveBeenCalledExactlyOnceWith({ exitCode: 0 });
  });

  it("keeps ordinary commands on the default user with stdin closed", async () => {
    const { client, sandboxes } = makeClient();
    const { id } = await client.create();
    await collect(client.exec(id, ["true"]));
    expect(sandboxes[0].runCalls.at(-1)!.opts).not.toHaveProperty("user");
    expect(sandboxes[0].runCalls.at(-1)!.opts).not.toHaveProperty("stdin");
    expect(sandboxes[0].sendStdin).not.toHaveBeenCalled();
  });

  it("stops a process whose input could not be delivered and reports the transport error", async () => {
    const { client, sandboxes } = makeClient();
    const { id } = await client.create();
    let finish!: (result: E2BCommandResult) => void;
    sandboxes[0].processWait = () => new Promise((resolve) => { finish = resolve; });
    sandboxes[0].processKill.mockImplementation(async () => { finish({ exitCode: 137, stdout: "", stderr: "" }); return true; });
    sandboxes[0].sendStdin.mockRejectedValueOnce(new Error("stdin RPC unavailable"));
    const onExit = vi.fn();
    await expect(collect(client.exec(id, ["bash", "-c", "read -r line"], { user: "root", stdin: "request\n", onExit }))).rejects.toThrow("stdin RPC unavailable");
    expect(sandboxes[0].processKill).toHaveBeenCalledOnce();
    expect(onExit).not.toHaveBeenCalled();
  });
});

describe('managed Sandbox lifetime and exit evidence', () => {
  it('does not turn an acknowledged kill plus a broken stream into exit evidence', async () => {
    const { client, sandboxes } = makeClient();
    const { id } = await client.create();
    const controller = new AbortController();
    const onExit = vi.fn();
    let waiting!: () => void;
    let rejectWait!: (error: Error) => void;
    const ready = new Promise<void>(resolve => { waiting = resolve; });
    sandboxes[0].processWait = () => { waiting(); return new Promise((_, reject) => { rejectWait = reject; }); };
    sandboxes[0].processKill.mockImplementation(async () => { rejectWait(new Error('transport lost')); return true; });
    const run = collect(client.exec(id, ['sleep', '999'], { signal: controller.signal, onExit }));
    const rejected = expect(run).rejects.toThrow('transport');
    await ready; controller.abort(); await rejected;
    expect(onExit).not.toHaveBeenCalled();
    expect(client.hasUncertainExecution(id)).toBe(true);
  });
  it('does not treat a DNS ENOTFOUND during deletion as a missing Sandbox', async () => {
    const { client, sandboxes } = makeClient();
    const { id } = await client.create();
    sandboxes[0].kill = async () => { throw new Error('getaddrinfo ENOTFOUND gateway'); };
    await expect(client.destroy(id)).rejects.toThrow('ENOTFOUND');
    expect(await client.state(id)).toBe("running");
  });
  it('requests one finite native lifecycle and bounded server creation budgets', async () => {
    const { client, factoryCalls } = makeClient();
    await client.create({ metadata: { 'oma.dev/binding': 'parent' } });
    expect(factoryCalls[0].opts).toMatchObject({
      timeoutMs: 86400000, lifecycle: { onTimeout: 'pause', autoResume: false },
      metadata: { 'oma.dev/binding': 'parent',
        'e2b.agents.kruise.io/reserve-paused-sandbox-duration': '24h',
        'e2b.agents.kruise.io/claim-timeout-seconds': '150',
        'e2b.agents.kruise.io/wait-ready-timeout-seconds': '135' },
    });
    expect(factoryCalls[0].opts.metadata).not.toHaveProperty('e2b.agents.kruise.io/never-timeout');
  });
  it('derives every creation budget from the gateway claim timeout', () => {
    expect([WAIT_READY_SECONDS, CLAIM_SECONDS, CREATE_REQUEST_MS / 1000, INTENT_DEADLINE_SECONDS])
      .toEqual([135, 150, 170, 180]);
  });
  it('retains uncertainty after a lost command stream, even if a later command exits', async () => {
    const { client, sandboxes } = makeClient();
    const { id } = await client.create();
    sandboxes[0].processWait = async () => { throw new Error('transport disconnected'); };
    sandboxes[0].processKill.mockRejectedValueOnce(new Error('network unavailable'));
    await expect((async () => { for await (const _ of client.exec(id, ['sleep', '999'])) {} })()).rejects.toThrow('transport');
    expect(client.hasUncertainExecution(id)).toBe(true);
    sandboxes[0].processWait = undefined;
    for await (const _ of client.exec(id, ['true'])) {}
    expect(client.hasUncertainExecution(id)).toBe(true);
  });
  it('clears activity on an observed nonzero exit and on an abort before process creation', async () => {
    const { client } = makeClient(() => ({ exitCode: 2, throwExit: true }));
    const { id } = await client.create();
    for await (const _ of client.exec(id, ['false'])) {}
    expect(client.hasUncertainExecution(id)).toBe(false);
    const signal = AbortSignal.abort();
    await expect((async () => { for await (const _ of client.exec(id, ['true'], { signal })) {} })()).rejects.toBeInstanceOf(ExecAbortedBeforeStartError);
    expect(client.hasUncertainExecution(id)).toBe(false);
  });
});

async function collect(
  it: AsyncIterable<SandboxExecChunk>,
): Promise<SandboxExecChunk[]> {
  const chunks: SandboxExecChunk[] = [];
  for await (const c of it) chunks.push(c);
  return chunks;
}

describe("E2BSandboxClient", () => {
  it("requires domain and apiKey", () => {
    expect(
      () =>
        new E2BSandboxClient({
          domain: "",
          apiKey: "k",
          verifyWorkspaceProbe: async () => {},
        }),
    ).toThrow(/domain/);
    expect(
      () =>
        new E2BSandboxClient({
          domain: "d",
          apiKey: "",
          verifyWorkspaceProbe: async () => {},
        }),
    ).toThrow(/apiKey/);
  });

  it("defaults to auto-story-v2 while preserving explicit Agent template selection", async () => {
    const templates: string[] = [];
    const client = new E2BSandboxClient({
      domain: "sandbox.example.com",
      apiKey: "gw-key",
      verifyWorkspaceProbe: async () => {},
      createSandbox: async (template) => {
        templates.push(template);
        return new FakeSandbox(`default-${templates.length}`);
      },
    });

    await client.create();
    await client.create({ image: "legacy/container:latest" });
    await client.create({ image: "agent-specific-template" });

    expect(templates).toEqual(["auto-story-v2", "auto-story-v2", "agent-specific-template"]);
  });

  it("create passes templateID + apiKey + domain and returns the sandboxId", async () => {
    const { client, factoryCalls } = makeClient();
    const handle = await client.create({
      env: { FOO: "bar" },
      metadata: { sessionId: "s1" },
      timeoutSeconds: 30,
    });
    expect(handle.id).toBe("sbx-1");
    expect(factoryCalls).toHaveLength(1);
    expect(factoryCalls[0].template).toBe("configured-template");
    expect(factoryCalls[0].opts.apiKey).toBe("gw-key");
    expect(factoryCalls[0].opts.domain).toBe("sandbox.example.com");
    expect(factoryCalls[0].opts.envs).toEqual({ FOO: "bar" });
    expect(factoryCalls[0].opts.metadata).toMatchObject({ sessionId: "s1" });
    expect(factoryCalls[0].opts.timeoutMs).toBe(30_000);
  });

  it("create maps opts.image to the template, else uses defaultTemplate", async () => {
    const { client, factoryCalls } = makeClient();
    await client.create({ image: "my-custom-set" });
    expect(factoryCalls[0].template).toBe("my-custom-set");
  });

  it("create ignores a container-image-style image and uses the default template", async () => {
    // Legacy Agents persisted sandbox.image as a container ref, which is not a
    // valid E2B template name — the client must fall back to defaultTemplate.
    const { client, factoryCalls } = makeClient();
    await client.create({ image: "open-managed-agents/sandbox:latest" });
    expect(factoryCalls[0].template).toBe("configured-template");
  });

  it("create leaves mount provisioning to CSI and waits past the gateway's claim timeout", async () => {
    const { client, sandboxes, factoryCalls } = makeClient();
    await client.create();
    expect(sandboxes[0].runCalls).toEqual([]);
    expect(factoryCalls[0].opts.requestTimeoutMs).toBe(170_000);
  });

  const target = {
    mountPath: "/home/user/workspace",
    bucket: "agentry",
    prefix: "tenant_1/ws_1/",
  };
  const mountOptions = {
    metadata: {
      "security.agents.kruise.io/agent-name": "agentry-workspace",
      "e2b.agents.kruise.io/csi-volume-config":
        '[{"pvName":"agentry-workspace-oss","mountPath":"/home/user/workspace","subPath":"tenant_1/ws_1","attributes":{"credentialProviderName":"agentry-oss-rw"}}]',
    },
  };
  const probe = {
    probeName: "a".repeat(32),
    content: "b".repeat(64),
    realPath: "/run/csi/mount-root/oss/" + "c".repeat(32),
  };
  const validProbe = (cmd: string) => ({
    stdout: cmd.includes("OMA_WORKSPACE_PROBE_REMOVED")
      ? "OMA_WORKSPACE_PROBE_REMOVED\n"
      : JSON.stringify(probe),
  });

  it("proves ordinary-user mount writes reach the exact Host OSS prefix then removes the probe", async () => {
    const readback = vi.fn(async () => {});
    const { client, sandboxes } = makeClient(validProbe, {
      verifyWorkspaceProbe: readback,
    });
    const { id } = await client.create(mountOptions);
    await client.verifyWorkspaceMount(id, target);
    expect(readback).toHaveBeenCalledWith(
      target,
      probe.probeName,
      probe.content,
    );
    expect(sandboxes[0].runCalls).toHaveLength(2);
    expect(sandboxes[0].runCalls[0].cmd).toContain("/proc/self/mountinfo");
    expect(sandboxes[0].runCalls[0].cmd).toContain(".oma-workspace-checks");
    for (const call of sandboxes[0].runCalls) {
      expect(call.opts?.user).toBe("user");
      expect(call.opts?.timeoutMs).toBe(20_000);
    }
  });

  it("rejects another prefix in gateway identity metadata before creating a probe", async () => {
    const { client, sandboxes } = makeClient(validProbe);
    const { id } = await client.create(mountOptions);
    sandboxes[0].metadata["security.agents.kruise.io/storage-auth"] =
      '[{"credentialProviderName":"agentry-oss-rw","attributes":{"bucket-name":"agentry","sub-path":"other/ws_1"}}]';
    await expect(client.verifyWorkspaceMount(id, target)).rejects.toThrow(
      /Workspace storage/,
    );
    expect(sandboxes[0].runCalls).toEqual([]);
  });

  it("failed Host readback still cleans the probe and never exposes provider diagnostics", async () => {
    const { client, sandboxes } = makeClient(validProbe, {
      verifyWorkspaceProbe: async () => {
        throw new Error("secret STS token");
      },
    });
    const { id } = await client.create(mountOptions);
    await expect(client.verifyWorkspaceMount(id, target)).rejects.toThrow(
      /Workspace storage/,
    );
    expect(sandboxes[0].runCalls.at(-1)?.cmd).toContain(
      "OMA_WORKSPACE_PROBE_REMOVED",
    );
    await expect(client.verifyWorkspaceMount(id, target)).rejects.not.toThrow(
      /secret/,
    );
  });

  it("fails closed on missing mount, read/write or cleanup errors", async () => {
    for (const failCleanup of [false, true]) {
      const { client } = makeClient((cmd) => {
        if (cmd.includes("OMA_WORKSPACE_PROBE_REMOVED") || !failCleanup)
          return {
            stdout: "",
            stderr: "private provider diagnostics",
            exitCode: 1,
          };
        return validProbe(cmd);
      });
      const { id } = await client.create(mountOptions);
      await expect(client.verifyWorkspaceMount(id, target)).rejects.toThrow(
        /Workspace storage/,
      );
    }
  });

  it("exec streams stdout and stderr chunks and wraps in cd/argv", async () => {
    const { client, sandboxes } = makeClient((cmd) => {
      if (cmd.includes("'echo'")) {
        return { stdout: "hello\n", stderr: "warn\n" };
      }
      return {};
    });
    const { id } = await client.create();
    const chunks = await collect(
      client.exec(id, ["echo", "hello"], { cwd: "/workspace" }),
    );
    expect(chunks).toEqual([
      { stream: "stdout", text: "hello\n" },
      { stream: "stderr", text: "warn\n" },
    ]);
    const echoCall = sandboxes[0].runCalls.at(-1)!;
    expect(echoCall.cmd).toBe("cd '/workspace' && exec 'echo' 'hello'");
  });

  it("forwards raw SDK bytes once and flushes decoded text before reporting exit", async () => {
    const { client, sandboxes } = makeClient();
    const { id } = await client.create();
    sandboxes[0].processWait = async () => {
      const options = sandboxes[0].runCalls.at(-1)!.opts!;
      await options.onStdoutBytes!(new Uint8Array([0xef, 0xbb]));
      await options.onStdout!("");
      await options.onStderrBytes!(new Uint8Array([255, 0]));
      await options.onStderr!("�\0");
      await options.onStdoutBytes!(new Uint8Array([0xbf, 0xe4, 0xb8, 0xad, 0xe4]));
      await options.onStdout!("\uFEFF中");
      await options.onStdout!("�");
      return { exitCode: 0, stdout: "\uFEFF中�", stderr: "�\0" };
    };
    const chunks: SandboxExecChunk[] = [];
    const onExit = vi.fn(() => {
      expect(chunks.filter((chunk) => chunk.stream === "stdout").map((chunk) => chunk.text).join("")).toBe("\uFEFF中�");
    });
    for await (const chunk of client.exec(id, ["raw-command"], { onExit })) chunks.push(chunk);
    expect(Buffer.concat(chunks.filter((chunk) => chunk.stream === "stdout").map((chunk) => chunk.bytes!))).toEqual(Buffer.from([0xef, 0xbb, 0xbf, 0xe4, 0xb8, 0xad, 0xe4]));
    expect(Buffer.concat(chunks.filter((chunk) => chunk.stream === "stderr").map((chunk) => chunk.bytes!))).toEqual(Buffer.from([255, 0]));
    expect(chunks.filter((chunk) => chunk.stream === "stderr").map((chunk) => chunk.text).join("")).toBe("�\0");
    expect(onExit).toHaveBeenCalledExactlyOnceWith({ exitCode: 0 });
  });

  it("provides a stable native filesystem capability scoped to a live sandbox", async () => {
    const { client } = makeClient();
    const a = await client.create();
    const b = await client.create();
    expect(client.fileSystem(a.id)).toBe(client.fileSystem(a.id));
    expect(client.fileSystem(a.id)).not.toBe(client.fileSystem(b.id));
    await client.destroy(a.id);
    expect(() => client.fileSystem(a.id)).toThrow("No live sandbox");
  });

  it("exec surfaces a non-zero exit as streamed stderr, not a throw", async () => {
    const { client } = makeClient((cmd) => {
      if (cmd.includes("'false'")) {
        return { stderr: "boom\n", exitCode: 1, throwExit: true };
      }
      return {};
    });
    const { id } = await client.create();
    const chunks = await collect(client.exec(id, ["false"]));
    // The failing command's stderr streams through; no throw.
    expect(chunks).toEqual([{ stream: "stderr", text: "boom\n" }]);
  });

  it("exec passes env and timeout through to commands.run", async () => {
    const { client, sandboxes } = makeClient();
    const { id } = await client.create();
    await collect(
      client.exec(id, ["ls"], { env: { A: "1" }, timeoutSeconds: 5 }),
    );
    const call = sandboxes[0].runCalls.at(-1)!;
    expect(call.opts?.envs).toEqual({ A: "1" });
    expect(call.opts?.timeoutMs).toBe(5_000);
  });

  it("exec maps timeoutSeconds: 40 to timeoutMs: 40000 (#81)", async () => {
    const { client, sandboxes } = makeClient();
    const { id } = await client.create();
    await collect(client.exec(id, ["ls"], { timeoutSeconds: 40 }));
    expect(sandboxes[0].runCalls.at(-1)!.opts?.timeoutMs).toBe(40_000);
  });

  it("exec maps timeoutSeconds: 0 (disabled) to timeoutMs: 0 — e2b treats 0 as no timeout (#81)", async () => {
    // `0` is the disable-timeout convention (mirrors e2b SDK `timeoutMs: 0`).
    // It must reach the SDK as `timeoutMs: 0`, NOT be dropped as falsy.
    const { client, sandboxes } = makeClient();
    const { id } = await client.create();
    await collect(client.exec(id, ["ls"], { timeoutSeconds: 0 }));
    expect(sandboxes[0].runCalls.at(-1)!.opts?.timeoutMs).toBe(0);
  });

  it("exec retains a process handle without passing the turn signal to its stream", async () => {
    const { client, sandboxes } = makeClient();
    const { id } = await client.create();
    const controller = new AbortController();
    await collect(client.exec(id, ["ls"], { signal: controller.signal }));
    expect(sandboxes[0].runCalls.at(-1)!.opts?.signal).toBeUndefined();
    expect(sandboxes[0].runCalls.at(-1)!.opts?.background).toBe(true);
  });

  it.each([0, 1, 2, 7])("reports exit code %i once after output is consumed", async (exitCode) => {
    const { client } = makeClient((cmd) => cmd.includes("'rg'")
      ? { stdout: "matches\n", exitCode, throwExit: exitCode !== 0 }
      : {});
    const { id } = await client.create();
    const events: unknown[] = [];
    for await (const chunk of client.exec(id, ["rg", "a"], {
      onExit: (result) => events.push(result),
    })) events.push(chunk);
    expect(events).toEqual([
      { stream: "stdout", text: "matches\n" },
      { exitCode },
    ]);
  });

  it.each([false, true])("kills the process when cancellation occurs %s during startup", async (duringStartup) => {
    const { client, sandboxes } = makeClient();
    const { id } = await client.create();
    const sandbox = sandboxes[0];
    const controller = new AbortController();
    const onExit = vi.fn();
    let releaseStart!: () => void;
    let started!: () => void;
    let waiting!: () => void;
    let rejectWait!: (error: unknown) => void;
    const startSeen = new Promise<void>((resolve) => { started = resolve; });
    const waitSeen = new Promise<void>((resolve) => { waiting = resolve; });
    const startup = new Promise<void>((resolve) => { releaseStart = resolve; });
    sandbox.backgroundStart = async () => { started(); await startup; };
    sandbox.processWait = () => {
      waiting();
      return new Promise((_resolve, reject) => { rejectWait = reject; });
    };
    sandbox.processKill.mockImplementation(async () => {
      // wait() rejects before the kill RPC resolves, as a real fast SIGKILL can.
      rejectWait({ exitCode: 137 });
      await new Promise((resolve) => setTimeout(resolve, 0));
      return true;
    });
    const running = collect(client.exec(id, ["rg", "a"], {
      signal: controller.signal, onExit,
    }));
    const rejected = expect(running).rejects.toMatchObject({ name: "AbortError" });
    await startSeen;
    if (duringStartup) controller.abort();
    releaseStart();
    await waitSeen;
    if (!duringStartup) controller.abort();
    await rejected;
    expect(sandbox.processKill).toHaveBeenCalledExactlyOnceWith();
    expect(onExit).toHaveBeenCalledExactlyOnceWith({ exitCode: null, signal: "SIGKILL" });
    expect(sandbox.runCalls.at(-1)!.opts?.signal).toBeUndefined();
  });

  it("does not start an already cancelled command", async () => {
    const { client, sandboxes } = makeClient();
    const { id } = await client.create();
    const before = sandboxes[0].runCalls.length;
    await expect(collect(client.exec(id, ["rg", "a"], {
      signal: AbortSignal.abort(),
    }))).rejects.toBeInstanceOf(ExecAbortedBeforeStartError);
    expect(sandboxes[0].runCalls).toHaveLength(before);
  });

  it("surfaces a failed kill without claiming the process exited or waiting forever", async () => {
    const { client, sandboxes } = makeClient();
    const { id } = await client.create();
    const sandbox = sandboxes[0];
    const controller = new AbortController();
    const onExit = vi.fn();
    let waiting!: () => void;
    const waitSeen = new Promise<void>((resolve) => { waiting = resolve; });
    sandbox.processWait = () => {
      waiting();
      return new Promise(() => {});
    };
    sandbox.processKill.mockRejectedValue(new Error("kill RPC unavailable"));
    const running = collect(client.exec(id, ["rg", "a"], {
      signal: controller.signal, onExit,
    }));
    const rejected = expect(running).rejects.toThrow("kill RPC unavailable");
    await waitSeen;
    controller.abort();
    await rejected;
    expect(onExit).not.toHaveBeenCalled();
    expect(sandbox.processDisconnect).toHaveBeenCalledExactlyOnceWith();
  });

  it("kills and waits for the process when a stream consumer stops early", async () => {
    const { client, sandboxes } = makeClient();
    const { id } = await client.create();
    const sandbox = sandboxes[0];
    const onExit = vi.fn();
    let rejectWait!: (reason: unknown) => void;
    sandbox.processWait = () => {
      void sandbox.runCalls.at(-1)!.opts!.onStdout!("one match\n");
      return new Promise((_resolve, reject) => { rejectWait = reject; });
    };
    sandbox.processKill.mockImplementation(async () => {
      rejectWait({ exitCode: 137 });
      return true;
    });
    for await (const _chunk of client.exec(id, ["rg", "a"], { onExit })) break;
    expect(sandbox.processKill).toHaveBeenCalledExactlyOnceWith();
    expect(onExit).toHaveBeenCalledExactlyOnceWith({ exitCode: null, signal: "SIGKILL" });
  });

  it("readFile reads via files.read", async () => {
    const { client, sandboxes } = makeClient();
    const { id } = await client.create();
    sandboxes[0].reads.set("/workspace/a.txt", "file-body");
    expect(await client.readFile(id, "/workspace/a.txt")).toBe("file-body");
  });

  it("writeFile writes via files.write (SDK creates parent dirs)", async () => {
    const { client, sandboxes } = makeClient();
    const { id } = await client.create();
    await client.writeFile(id, "/workspace/dir/b.txt", "payload");
    expect(sandboxes[0].writes).toContainEqual({
      path: "/workspace/dir/b.txt",
      data: "payload",
    });
  });

  it("reads and writes exact bytes through the E2B bytes format", async () => {
    const { client, sandboxes } = makeClient();
    const { id } = await client.create();
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    sandboxes[0].reads.set("/workspace/image.png", bytes);

    expect(await client.readFileBytes(id, "/workspace/image.png")).toEqual(
      bytes,
    );
    await client.writeFileBytes(id, "/workspace/copy.png", bytes);

    const written = sandboxes[0].writes.find(
      (entry) => entry.path === "/workspace/copy.png",
    );
    expect(new Uint8Array(written!.data as ArrayBuffer)).toEqual(bytes);
  });

  it("removes a file or directory through the E2B filesystem API", async () => {
    const { client, sandboxes } = makeClient();
    const { id } = await client.create();
    sandboxes[0].reads.set("/skills/a/SKILL.md", "body");

    await client.remove(id, "/skills/a");

    expect(sandboxes[0].removes).toEqual(["/skills/a"]);
    expect(sandboxes[0].reads.has("/skills/a/SKILL.md")).toBe(false);
  });

  it("list runs find and parses recursive entries", async () => {
    const findOut =
      "1700000000.5 12 /workspace/a.txt\n1700000001 4 /workspace/d/b.txt\n";
    const { client, sandboxes } = makeClient((cmd) =>
      cmd.includes("find") ? { stdout: findOut } : {},
    );
    const { id } = await client.create();
    const entries = await client.list(id, "/workspace");
    expect(entries).toEqual([
      { path: "/workspace/a.txt", size: 12, mtimeMs: 1700000000500 },
      { path: "/workspace/d/b.txt", size: 4, mtimeMs: 1700000001000 },
    ]);
    const findCall = sandboxes[0].runCalls.find((c) => c.cmd.includes("find"));
    expect(findCall!.cmd).toContain("'/workspace'");
    expect(findCall!.cmd).toContain("-type f");
  });

  it("lists an optional missing directory as empty without creating it", async () => {
    const { client, sandboxes } = makeClient(() => ({ stdout: '\u001eoma-fs:{"ok":false,"error":{"code":"ENOENT","message":"directory missing"}}\n' }));
    const { id } = await client.create();
    expect(await client.list(id, "/skills", { missingOk: true })).toEqual([]);
    expect(sandboxes[0].writes).toEqual([]);
  });

  it("preserves access and transport errors while probing optional directories", async () => {
    const { client, sandboxes } = makeClient(() => ({ stdout: '\u001eoma-fs:{"ok":false,"error":{"code":"EACCES","message":"permission denied"}}\n' }));
    const { id } = await client.create();
    await expect(client.list(id, "/private/skills", { missingOk: true })).rejects.toMatchObject({ code: "EACCES" });
    sandboxes[0].processWait = async () => { throw new Error("gateway disconnected"); };
    await expect(client.list(id, "/skills", { missingOk: true })).rejects.toThrow("gateway disconnected");
  });

  it("list reports filesystem failures instead of pretending the directory is empty", async () => {
    const { client } = makeClient(() => ({
      stdout: "",
      stderr: "Input/output error",
      exitCode: 1,
    }));
    const { id } = await client.create();
    await expect(client.list(id, "/home/user/workspace")).rejects.toThrow(
      /list/i,
    );
  });

  it("control-plane state distinguishes Running and Paused without a health request", async () => {
    const { client, sandboxes } = makeClient();
    const { id } = await client.create();
    expect(await client.state(id)).toBe("running");
    sandboxes[0].running = false;
    expect(await client.state(id)).toBe("paused");
  });

  it("control-plane state distinguishes a missing Sandbox", async () => {
    const { client } = makeClient();
    expect(await client.state("never-created")).toBe("missing");
    const { id } = await client.create();
    await client.destroy(id);
    expect(await client.state(id)).toBe("missing");
  });

  it("does not reclaim a potentially live Sandbox on a transport error", async () => {
    const { client, sandboxes } = makeClient();
    const { id } = await client.create();
    sandboxes[0].isRunningThrows = true;
    await expect(client.state(id)).rejects.toThrow();
  });

  it("destroy kills the sandbox and is idempotent", async () => {
    const { client, sandboxes } = makeClient();
    const { id } = await client.create();
    await client.destroy(id);
    expect(sandboxes[0].killed).toBe(true);
    // Second destroy is a no-op (no throw, sandbox already gone).
    await expect(client.destroy(id)).resolves.toBeUndefined();
  });

  it("destroy reports transport failure and retains the handle so cleanup can be retried", async () => {
    const { client, sandboxes } = makeClient();
    const { id } = await client.create();
    const kill = vi
      .spyOn(sandboxes[0], "kill")
      .mockRejectedValueOnce(new Error("gateway temporarily unavailable"));
    await expect(client.destroy(id)).rejects.toThrow(/temporarily unavailable/);
    await client.destroy(id);
    expect(kill).toHaveBeenCalledTimes(2);
    expect(await client.state(id)).toBe("missing");
  });

  it("destroy swallows a kill failure (idempotent)", async () => {
    const { client } = makeClient(undefined, { failKill: true });
    const { id } = await client.create();
    await expect(client.destroy(id)).resolves.toBeUndefined();
  });

  it("ops on an unknown id throw", async () => {
    const { client } = makeClient();
    await expect(client.readFile("nope", "/x")).rejects.toThrow(
      /No live sandbox/,
    );
  });
});

describe("parseFindOutput", () => {
  it("skips malformed lines and sorts by path", () => {
    const out = "\n1700.0 5 /z\ngarbage\n1700.0 10 /a\n";
    expect(parseFindOutput(out)).toEqual([
      { path: "/a", size: 10, mtimeMs: 1700000 },
      { path: "/z", size: 5, mtimeMs: 1700000 },
    ]);
  });
});

describe("resolveTemplate", () => {
  it("uses the default when no image is given", () => {
    expect(resolveTemplate(undefined, "configured-template")).toBe(
      "configured-template",
    );
  });

  it("honours a bare template name", () => {
    expect(resolveTemplate("my-set", "configured-template")).toBe("my-set");
  });

  it("falls back to default for a container-image ref (registry path or tag)", () => {
    expect(
      resolveTemplate("open-managed-agents/sandbox:latest", "configured-template"),
    ).toBe("configured-template");
    expect(resolveTemplate("nginx:1.25", "configured-template")).toBe(
      "configured-template",
    );
    expect(resolveTemplate("repo/image", "configured-template")).toBe(
      "configured-template",
    );
  });
});

describe('direct lifecycle control-plane operations', () => {
  afterEach(() => { vi.restoreAllMocks(); });
  it('deletes an uncached Paused identity without connecting, and requires deletion confirmation', async () => {
    const kill = vi.fn(async () => true);
    const info = vi.fn().mockResolvedValueOnce({ state: 'paused' }).mockRejectedValueOnce(new SandboxNotFoundError('missing'));
    const connect = vi.fn();
    const client = new E2BSandboxClient({ domain: 'example.test', apiKey: 'fixture', verifyWorkspaceProbe: async () => {},
      killSandbox: kill, getSandboxInfo: info, connectSandbox: connect });
    await expect(client.destroy('paused-from-another-runner')).rejects.toThrow(/not yet confirmed/);
    await client.destroy('paused-from-another-runner');
    expect(kill).toHaveBeenCalledTimes(2);
    expect(connect).not.toHaveBeenCalled();
  });
  it('refreshes the 24h deadline on every explicit reconnect, including a cached identity', async () => {
    const connect = vi.fn(async () => new FakeSandbox('same-id'));
    const client = new E2BSandboxClient({ domain: 'example.test', apiKey: 'fixture', verifyWorkspaceProbe: async () => {}, connectSandbox: connect });
    await client.reconnect('same-id', {});
    await client.reconnect('same-id', {});
    expect(connect).toHaveBeenCalledTimes(2);
    expect(connect).toHaveBeenLastCalledWith('same-id', expect.objectContaining({ timeoutMs: 86400000 }));
  });
  it('bounds connect by its own signal and gives the handle the same request default as a created one', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const connect = vi.fn(async (_id: string, _opts: { signal: AbortSignal; requestTimeoutMs: number }) => new FakeSandbox('same-id'));
    const client = new E2BSandboxClient({ domain: 'example.test', apiKey: 'fixture', verifyWorkspaceProbe: async () => {}, connectSandbox: connect });
    await client.reconnect('same-id', {});
    expect(timeout).toHaveBeenCalledWith(60_000);
    expect(connect.mock.calls[0][1].signal).toBe(timeout.mock.results[0].value);
    expect(connect.mock.calls[0][1].requestTimeoutMs).toBe(170_000);
  });
  it('bounds every other control-plane call by its own timeout, shorter than create', async () => {
    const getInfo = vi.spyOn(Sandbox, 'getInfo').mockResolvedValueOnce({ state: 'running' } as Awaited<ReturnType<typeof Sandbox.getInfo>>)
      .mockRejectedValueOnce(new SandboxNotFoundError('missing'));
    const kill = vi.spyOn(Sandbox, 'kill').mockResolvedValue(true);
    const setTimeout = vi.spyOn(Sandbox, 'setTimeout').mockResolvedValue();
    const client = new E2BSandboxClient({ domain: 'example.test', apiKey: 'fixture', verifyWorkspaceProbe: async () => {} });
    expect(await client.state('id')).toBe('running');
    await client.setTimeout('id', 1800);
    await client.destroy('id');
    expect(getInfo).toHaveBeenCalledWith('id', expect.objectContaining({ apiKey: 'fixture', requestTimeoutMs: 20_000 }));
    expect(setTimeout).toHaveBeenCalledWith('id', 1_800_000, expect.objectContaining({ requestTimeoutMs: 30_000 }));
    expect(kill).toHaveBeenCalledWith('id', expect.objectContaining({ requestTimeoutMs: 30_000 }));
  });
});

describe('environmental stream failure', () => {
  it('returns uncertainty without issuing a destructive cleanup RPC that can stall on Paused', async () => {
    const { client, sandboxes } = makeClient();
    const { id } = await client.create();
    sandboxes[0].processWait = async () => { throw new Error('transport timeout while paused'); };
    await expect(collect(client.exec(id, ['long-command']))).rejects.toThrow('transport timeout');
    expect(sandboxes[0].processKill).not.toHaveBeenCalled();
    expect(sandboxes[0].processDisconnect).toHaveBeenCalledOnce();
    expect(client.hasUncertainExecution(id)).toBe(true);
  });
});

describe("listing Sandboxes from the gateway (ADR-0023)", () => {
  /**
   * A gateway on localhost that parses `metadata` as upstream
   * pkg/servers/e2b/list.go does: the query string's decoding, one more
   * unescape, then a split into key=value pairs, no further decoding.
   */
  async function gateway(pages: Array<{ body: unknown[]; next?: string }>) {
    const { createServer } = await import("node:http");
    const requests: Array<{ url: URL; apiKey?: string; metadata: Record<string, string> }> = [];
    const server = createServer((request, response) => {
      const url = new URL(request.url!, "http://gateway");
      const metadata = Object.fromEntries(decodeURIComponent(url.searchParams.get("metadata") ?? "").split("&")
        .filter(Boolean).map((pair) => pair.split("=", 2) as [string, string]));
      requests.push({ url, apiKey: request.headers["x-api-key"] as string | undefined, metadata });
      const page = pages[requests.length - 1];
      if (!page) { response.writeHead(500).end(JSON.stringify({ message: "secret annotation" })); return; }
      response.writeHead(200, { "content-type": "application/json", ...(page.next ? { "x-next-token": page.next } : {}) });
      response.end(JSON.stringify(page.body));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    vi.stubEnv("E2B_API_URL", `http://127.0.0.1:${port}`);
    return { requests, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
  }
  const entry = (sandboxID: string, extra: Record<string, unknown> = {}) => ({
    sandboxID, templateID: "auto-story-v2", state: "running", metadata: { "oma.dev/binding": "sesn_1" },
    startedAt: "2026-10-22T13:20:10Z", endAt: "2026-10-23T13:20:10Z", cpuCount: 2, memoryMB: 4096, ...extra,
  });
  const client = () => new E2BSandboxClient({ domain: "sandbox.example.test", apiKey: "gateway-key", verifyWorkspaceProbe: async () => {} });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("filters by exact labels the gateway can parse, follows x-next-token and maps the year-1 deadline to none", async () => {
    const server = await gateway([
      { body: [entry("sbx-a"), entry("sbx-b", { state: "paused", endAt: "0001-01-01T00:00:00Z" })], next: "page-2" },
      { body: [entry("sbx-c", { metadata: null })] },
    ]);
    try {
      const listed = await client().listSandboxes({ metadata: { "oma.dev/binding": "sesn_1", "oma.dev/environment": "test" }, states: ["running", "paused"] });
      expect(listed).toEqual([
        { sandboxId: "sbx-a", state: "running", metadata: { "oma.dev/binding": "sesn_1" }, startedAt: new Date("2026-10-22T13:20:10Z"), endAt: new Date("2026-10-23T13:20:10Z") },
        { sandboxId: "sbx-b", state: "paused", metadata: { "oma.dev/binding": "sesn_1" }, startedAt: new Date("2026-10-22T13:20:10Z"), endAt: null },
        { sandboxId: "sbx-c", state: "running", metadata: {}, startedAt: new Date("2026-10-22T13:20:10Z"), endAt: new Date("2026-10-23T13:20:10Z") },
      ]);
      expect(server.requests.map(({ metadata }) => metadata)).toEqual(Array(2).fill({ "oma.dev/binding": "sesn_1", "oma.dev/environment": "test" }));
      expect(server.requests.map(({ url }) => [url.searchParams.get("state"), url.searchParams.get("limit"), url.searchParams.get("nextToken")]))
        .toEqual([["running,paused", "100", null], ["running,paused", "100", "page-2"]]);
      expect(server.requests.every(({ apiKey }) => apiKey === "gateway-key")).toBe(true);
    } finally { await server.close(); }
  });

  it("fails on a gateway error without repeating its body", async () => {
    const server = await gateway([]);
    try {
      const failure = await client().listSandboxes({ metadata: { "oma.dev/binding": "sesn_1" }, states: ["running"] }).catch((error: Error) => error);
      expect(failure).toEqual(new Error("Sandbox list answered HTTP 500"));
    } finally { await server.close(); }
  });
});

describe("classifying a failed create by the gateway's answer (ADR-0023)", () => {
  /** A gateway on localhost that answers every create with `answer`. */
  async function gateway(answer: (response: import("node:http").ServerResponse) => void) {
    const { createServer } = await import("node:http");
    const server = createServer((request, response) => {
      request.resume();
      request.on("end", () => answer(response));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    vi.stubEnv("E2B_API_URL", `http://127.0.0.1:${port}`);
    return { close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
  }
  /** The real SDK's create, as production calls it. */
  const create = () => new E2BSandboxClient({ domain: "sandbox.example.test", apiKey: "gateway-key", verifyWorkspaceProbe: async () => {} })
    .create({ metadata: { "oma.dev/binding": "sesn_1" } }).catch((error: unknown) => error);
  afterEach(() => { vi.unstubAllEnvs(); });

  it.each([400, 401, 403, 409, 429, 500, 503])("reports an HTTP %i answer by its status alone", async (status) => {
    const server = await gateway((response) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: status, message: "claim failed: secret annotation" }));
    });
    try {
      const failure = await create();
      expect(failure).toBeInstanceOf(SandboxCreateRejected);
      expect(failure).toMatchObject({ status, message: `Sandbox create answered HTTP ${status}` });
      expect(JSON.stringify(failure) + String(failure)).not.toMatch(/secret/);
    } finally { await server.close(); }
  });

  it("reports a connection lost before any answer as no answer at all", async () => {
    const server = await gateway((response) => { response.socket?.destroy(); });
    try {
      const failure = await create();
      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(SandboxCreateRejected);
    } finally { await server.close(); }
  });
});
