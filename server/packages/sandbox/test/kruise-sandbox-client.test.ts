import { describe, it, expect } from "vitest";
import {
  KruiseSandboxClient,
  parseFindOutput,
  type CommandRunner,
  type StreamRunner,
} from "../src/kruise-sandbox-client.js";
import type { SandboxExecChunk } from "../src/sandbox-client.js";

/**
 * A scripted CommandRunner: matches on a substring of the joined argv and
 * returns a canned result. Records every call for assertions.
 */
function scriptedRunner(
  routes: Array<{
    match: (argv: string[], stdin?: string) => boolean;
    result: { stdout?: string; stderr?: string; exitCode?: number };
  }>,
): { runner: CommandRunner; calls: Array<{ argv: string[]; stdin?: string }> } {
  const calls: Array<{ argv: string[]; stdin?: string }> = [];
  const runner: CommandRunner = async (argv, opts) => {
    calls.push({ argv, stdin: opts?.stdin });
    const route = routes.find((r) => r.match(argv, opts?.stdin));
    if (!route) {
      return { stdout: "", stderr: `no route for ${argv.join(" ")}`, exitCode: 1 };
    }
    return {
      stdout: route.result.stdout ?? "",
      stderr: route.result.stderr ?? "",
      exitCode: route.result.exitCode ?? 0,
    };
  };
  return { runner, calls };
}

const runningStatus = JSON.stringify({
  status: { phase: "Running", podInfo: { podName: "sbx-pod-1" } },
});

function baseRoutes(extra: Parameters<typeof scriptedRunner>[0] = []) {
  return scriptedRunner([
    { match: (a) => a.includes("apply"), result: { stdout: "{}" } },
    { match: (a) => a.includes("get"), result: { stdout: runningStatus } },
    // mkdir -p /workspace during create
    { match: (a) => a.join(" ").includes("mkdir -p"), result: {} },
    ...extra,
  ]);
}

describe("KruiseSandboxClient", () => {
  it("applies a Sandbox CR and waits for Running, capturing the pod", async () => {
    const { runner, calls } = baseRoutes();
    const client = new KruiseSandboxClient({
      runner,
      streamRunner: emptyStream(),
      generateId: () => "sbx-1",
      readyPollMs: 1,
    });

    const handle = await client.create({ image: "ubuntu:22.04" });
    expect(handle.id).toBe("sbx-1");

    const applyCall = calls.find((c) => c.argv.includes("apply"));
    expect(applyCall).toBeDefined();
    const manifest = JSON.parse(applyCall!.stdin!);
    expect(manifest.kind).toBe("Sandbox");
    expect(manifest.apiVersion).toBe("agents.kruise.io/v1alpha1");
    expect(manifest.metadata.name).toBe("sbx-1");
    expect(manifest.spec.runtimes[0].name).toBe("default");
    expect(manifest.spec.template.spec.containers[0].image).toBe("ubuntu:22.04");
  });

  it("polls until phase=Running before returning", async () => {
    let polls = 0;
    const { runner } = scriptedRunner([
      { match: (a) => a.includes("apply"), result: { stdout: "{}" } },
      {
        match: (a) => a.includes("get"),
        result: { stdout: "" }, // replaced below
      },
      { match: (a) => a.join(" ").includes("mkdir -p"), result: {} },
    ]);
    // Wrap runner to return Pending twice then Running.
    const wrapped: CommandRunner = async (argv, opts) => {
      if (argv.includes("get")) {
        polls++;
        const phase = polls < 3 ? "Pending" : "Running";
        return {
          stdout: JSON.stringify({
            status: { phase, podInfo: phase === "Running" ? { podName: "p" } : {} },
          }),
          stderr: "",
          exitCode: 0,
        };
      }
      return runner(argv, opts);
    };
    const client = new KruiseSandboxClient({
      runner: wrapped,
      streamRunner: emptyStream(),
      generateId: () => "sbx-2",
      readyPollMs: 1,
    });

    await client.create();
    expect(polls).toBe(3);
  });

  it("streams exec output via kubectl exec sh -lc", async () => {
    const streamCalls: string[][] = [];
    const streamRunner: StreamRunner = async function* (argv) {
      streamCalls.push(argv);
      yield { stream: "stdout", text: "hello\n" } as SandboxExecChunk;
    };
    const { runner } = baseRoutes();
    const client = new KruiseSandboxClient({
      runner,
      streamRunner,
      generateId: () => "sbx-3",
      readyPollMs: 1,
    });
    await client.create();

    const chunks: SandboxExecChunk[] = [];
    for await (const c of client.exec("sbx-3", ["echo", "hello"], {
      cwd: "/workspace",
    })) {
      chunks.push(c);
    }
    expect(chunks).toEqual([{ stream: "stdout", text: "hello\n" }]);
    // Last stream call is the echo (first was mkdir during create).
    const echoCall = streamCalls.at(-1)!;
    expect(echoCall).toContain("exec");
    expect(echoCall).toContain("sbx-pod-1");
    expect(echoCall.at(-1)).toContain("cd '/workspace' && 'echo' 'hello'");
  });

  it("readFile cats the file inside the pod", async () => {
    const { runner, calls } = baseRoutes([
      { match: (a) => a.includes("cat"), result: { stdout: "file-body" } },
    ]);
    const client = new KruiseSandboxClient({
      runner,
      streamRunner: emptyStream(),
      generateId: () => "sbx-4",
      readyPollMs: 1,
    });
    await client.create();

    const body = await client.readFile("sbx-4", "/workspace/a.txt");
    expect(body).toBe("file-body");
    const catCall = calls.find((c) => c.argv.includes("cat"));
    expect(catCall!.argv).toEqual([
      "kubectl",
      "-n",
      "sandbox-system",
      "exec",
      "sbx-pod-1",
      "--",
      "cat",
      "/workspace/a.txt",
    ]);
  });

  it("writeFile streams content over stdin into cat >", async () => {
    const { runner, calls } = baseRoutes([
      { match: (a) => a.join(" ").includes("cat >"), result: {} },
    ]);
    const client = new KruiseSandboxClient({
      runner,
      streamRunner: emptyStream(),
      generateId: () => "sbx-5",
      readyPollMs: 1,
    });
    await client.create();

    await client.writeFile("sbx-5", "/workspace/dir/b.txt", "payload");
    const writeCall = calls.find((c) => c.argv.join(" ").includes("cat >"));
    expect(writeCall).toBeDefined();
    expect(writeCall!.stdin).toBe("payload");
    expect(writeCall!.argv.join(" ")).toContain("mkdir -p '/workspace/dir'");
    expect(writeCall!.argv.join(" ")).toContain("cat > '/workspace/dir/b.txt'");
  });

  it("list parses find output into entries", async () => {
    const findOut = "1700000000.5 12 /workspace/a.txt\n1700000001 4 /workspace/d/b.txt\n";
    const { runner } = baseRoutes([
      { match: (a) => a.join(" ").includes("find"), result: { stdout: findOut } },
    ]);
    const client = new KruiseSandboxClient({
      runner,
      streamRunner: emptyStream(),
      generateId: () => "sbx-6",
      readyPollMs: 1,
    });
    await client.create();

    const entries = await client.list("sbx-6", "/workspace");
    expect(entries).toEqual([
      { path: "/workspace/a.txt", size: 12, mtimeMs: 1700000000500 },
      { path: "/workspace/d/b.txt", size: 4, mtimeMs: 1700000001000 },
    ]);
  });

  it("destroy deletes the CR (ignore-not-found)", async () => {
    const { runner, calls } = baseRoutes([
      { match: (a) => a.includes("delete"), result: {} },
    ]);
    const client = new KruiseSandboxClient({
      runner,
      streamRunner: emptyStream(),
      generateId: () => "sbx-7",
      readyPollMs: 1,
    });
    await client.create();

    await client.destroy("sbx-7");
    const del = calls.find((c) => c.argv.includes("delete"));
    expect(del!.argv).toContain("--ignore-not-found");
    expect(del!.argv).toContain("sandbox.agents.kruise.io");
    expect(del!.argv).toContain("sbx-7");
  });

  it("throws if create times out without reaching Running", async () => {
    const { runner } = scriptedRunner([
      { match: (a) => a.includes("apply"), result: { stdout: "{}" } },
      {
        match: (a) => a.includes("get"),
        result: { stdout: JSON.stringify({ status: { phase: "Pending" } }) },
      },
    ]);
    const client = new KruiseSandboxClient({
      runner,
      streamRunner: emptyStream(),
      generateId: () => "sbx-8",
      readyTimeoutSeconds: 0,
      readyPollMs: 1,
    });
    await expect(client.create()).rejects.toThrow(/not ready/);
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

function emptyStream(): StreamRunner {
  return async function* () {
    // no output
  };
}
