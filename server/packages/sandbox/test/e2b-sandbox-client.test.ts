import { describe, it, expect, vi } from "vitest";
import {
  E2BSandboxClient,
  parseFindOutput,
  resolveTemplate,
  type CreateSandboxFn,
  type E2BSandbox,
} from "../src/e2b-sandbox-client.js";
import type { SandboxExecChunk } from "../src/sandbox-client.js";

/** A recorded `commands.run` call. */
interface RunCall {
  cmd: string;
  opts?: {
    user?: string;
    cwd?: string;
    envs?: Record<string, string>;
    timeoutMs?: number;
    signal?: AbortSignal;
    onStdout?: (data: string) => void | Promise<void>;
    onStderr?: (data: string) => void | Promise<void>;
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
    run: async (
      cmd: string,
      opts?: RunCall["opts"],
    ): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
      this.runCalls.push({ cmd, opts });
      const r = this.runHandler?.(cmd) ?? {};
      if (r.stdout && opts?.onStdout) await opts.onStdout(r.stdout);
      if (r.stderr && opts?.onStderr) await opts.onStderr(r.stderr);
      const exitCode = r.exitCode ?? 0;
      if (r.throwExit) {
        // Mimic CommandExitError: an object carrying a numeric exitCode.
        throw { exitCode, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
      }
      return { exitCode, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    },
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
        throw new Error("not found");
      };
    }
    sandboxes.push(s);
    return s;
  };
  const client = new E2BSandboxClient({
    domain: "sandbox.example.com",
    apiKey: "gw-key",
    defaultTemplate: "code-interpreter",
    createSandbox,
    verifyWorkspaceProbe: opts?.verifyWorkspaceProbe ?? (async () => {}),
  });
  return { client, factoryCalls, sandboxes };
}

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

  it("create passes templateID + apiKey + domain and returns the sandboxId", async () => {
    const { client, factoryCalls } = makeClient();
    const handle = await client.create({
      env: { FOO: "bar" },
      metadata: { sessionId: "s1" },
      timeoutSeconds: 30,
    });
    expect(handle.id).toBe("sbx-1");
    expect(factoryCalls).toHaveLength(1);
    expect(factoryCalls[0].template).toBe("code-interpreter");
    expect(factoryCalls[0].opts.apiKey).toBe("gw-key");
    expect(factoryCalls[0].opts.domain).toBe("sandbox.example.com");
    expect(factoryCalls[0].opts.envs).toEqual({ FOO: "bar" });
    expect(factoryCalls[0].opts.metadata).toEqual({ sessionId: "s1" });
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
    expect(factoryCalls[0].template).toBe("code-interpreter");
  });

  it("create leaves mount provisioning to CSI and gives ALB cold starts enough request time", async () => {
    const { client, sandboxes, factoryCalls } = makeClient();
    await client.create();
    expect(sandboxes[0].runCalls).toEqual([]);
    expect(factoryCalls[0].opts.requestTimeoutMs).toBe(185_000);
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
    expect(echoCall.cmd).toBe("cd '/workspace' && 'echo' 'hello'");
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

  it("exec forwards the AbortSignal into commands.run by identity (#84)", async () => {
    const { client, sandboxes } = makeClient();
    const { id } = await client.create();
    const controller = new AbortController();
    await collect(client.exec(id, ["ls"], { signal: controller.signal }));
    expect(sandboxes[0].runCalls.at(-1)!.opts?.signal).toBe(controller.signal);
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

  it("isAlive reflects the sandbox isRunning state", async () => {
    const { client, sandboxes } = makeClient();
    const { id } = await client.create();
    expect(await client.isAlive(id)).toBe(true);
    sandboxes[0].running = false;
    expect(await client.isAlive(id)).toBe(false);
  });

  it("isAlive returns false for an unknown/destroyed id", async () => {
    const { client } = makeClient();
    expect(await client.isAlive("never-created")).toBe(false);
    const { id } = await client.create();
    await client.destroy(id);
    expect(await client.isAlive(id)).toBe(false);
  });

  it("isAlive treats an isRunning transport error as not alive", async () => {
    const { client, sandboxes } = makeClient();
    const { id } = await client.create();
    sandboxes[0].isRunningThrows = true;
    expect(await client.isAlive(id)).toBe(false);
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
    expect(await client.isAlive(id)).toBe(false);
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
    expect(resolveTemplate(undefined, "code-interpreter")).toBe(
      "code-interpreter",
    );
  });

  it("honours a bare template name", () => {
    expect(resolveTemplate("my-set", "code-interpreter")).toBe("my-set");
  });

  it("falls back to default for a container-image ref (registry path or tag)", () => {
    expect(
      resolveTemplate("open-managed-agents/sandbox:latest", "code-interpreter"),
    ).toBe("code-interpreter");
    expect(resolveTemplate("nginx:1.25", "code-interpreter")).toBe(
      "code-interpreter",
    );
    expect(resolveTemplate("repo/image", "code-interpreter")).toBe(
      "code-interpreter",
    );
  });
});
