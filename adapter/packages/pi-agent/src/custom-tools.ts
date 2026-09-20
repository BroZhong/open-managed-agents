import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createBashToolDefinition, createReadToolDefinition, createWriteToolDefinition,
  createEditToolDefinition, createLsToolDefinition, createGrepToolDefinition,
  createFindToolDefinition, defineTool, VERSION,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { SANDBOX_WORKSPACE_ROOT, type ToolExecutor, type ToolFileSystem } from "@open-managed-agents/adapter-core";
import { executorFileSystem, toExecutorPath } from "./native-files.js";
import { canonicalMutationPath } from "./mutation-path.js";
import { SANDBOX_TOOL_RUNTIME } from "./sandbox-tool-runtime.js";

type Result = Awaited<ReturnType<ToolDefinition["execute"]>>;
const mutationQueues = new WeakMap<ToolFileSystem, Map<string, Promise<void>>>();

/** Public customTools registrations. Native execute/render callbacks never run on Host. */
export function buildCustomTools(executor: ToolExecutor): ToolDefinition[] {
  const fs = executorFileSystem(executor);
  const factories = [createBashToolDefinition, createReadToolDefinition, createWriteToolDefinition,
    createEditToolDefinition, createLsToolDefinition, createGrepToolDefinition, createFindToolDefinition];
  return factories.map(factory => {
    const native = factory(SANDBOX_WORKSPACE_ROOT) as ToolDefinition;
    return defineTool({
      name: native.name, label: native.label, description: native.description,
      parameters: native.parameters, promptSnippet: native.promptSnippet,
      promptGuidelines: native.name === "bash" ? undefined : native.promptGuidelines,
      prepareArguments: native.prepareArguments,
      // Explicit renderers prevent same-name overrides inheriting Host file previews.
      renderCall: () => ({ render: () => [native.name], invalidate() {} }),
      renderResult: result => ({ render: () => result.content.flatMap(block =>
        block.type === "text" ? block.text.split("\n") : []), invalidate() {} }),
      async execute(id, args, signal, onUpdate, context) {
        signal?.throwIfAborted();
        const input = { ...(args as Record<string, unknown>) };
        const run = () => executeSandboxTool(executor, { sdkVersion: VERSION, id, name: native.name,
          args: input, workspaceRoot: SANDBOX_WORKSPACE_ROOT, model: context?.model }, signal, onUpdate);
        if (native.name !== "edit" && native.name !== "write") return run();
        // Normalize only the lock key; native execute receives the original syntax.
        let lockPath = String(input.path).replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, " ").replace(/^@/, "").replace(/^~(?=\/|$)/, "/home/user");
        if (lockPath.startsWith("file://")) lockPath = fileURLToPath(lockPath);
        const key = await canonicalMutationPath(fs, posix.resolve(SANDBOX_WORKSPACE_ROOT, lockPath), signal);
        let queues = mutationQueues.get(fs);
        if (!queues) mutationQueues.set(fs, queues = new Map());
        const operation = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(() => { signal?.throwIfAborted(); return run(); });
        const settled = operation.then(() => {}, () => {});
        queues.set(key, settled);
        try { return await operation; }
        finally { if (queues.get(key) === settled) queues.delete(key); }
      },
    });
  });
}

async function executeSandboxTool(executor: ToolExecutor, request: object, signal?: AbortSignal,
  onUpdate?: (result: Result) => void): Promise<Result> {
  const fs = executorFileSystem(executor);
  const requestPath = await fs.createTempFile({ signal });
  let accepted = false;
  let result: Result | undefined;
  let error: string | undefined;
  let exitCode: number | null | undefined;
  let pending = "";
  let diagnostic = "";
  let pid: number | undefined;
  let settledFrame = false;
  let cancelled: string | undefined;
  let cancellation: Promise<void> | undefined;
  // Backend cancellation can SIGKILL the wrapper without stopping Pi's detached
  // bash group. Ask Pi to abort, then wait for its settled frame and process exit.
  const cancel = () => {
    if (!pid || settledFrame || cancellation) return;
    cancellation = (async () => {
      for await (const _ of executor.exec(["node", "-e", "process.kill(Number(process.argv[1]), 'SIGTERM')", String(pid)], { cwd: ".", timeoutSeconds: 5 })) { /* drain */ }
    })().catch(() => { /* only the original execution can confirm cancellation */ });
  };
  const decoder = new TextDecoder();
  const consume = (text: string) => {
    pending += text;
    let newline: number;
    while ((newline = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (!line) continue;
      const frame = JSON.parse(line) as { type: string; result?: Result; message?: string; pid?: number };
      if (frame.type === "accepted" && Number.isSafeInteger(frame.pid) && frame.pid! > 1) {
        accepted = true; pid = frame.pid; if (signal?.aborted) cancel();
      }
      else if (frame.type === "update" && frame.result) { onUpdate?.(frame.result); }
      else if (frame.type === "result" && frame.result && !settledFrame) { result = frame.result; settledFrame = true; }
      else if (frame.type === "error" && typeof frame.message === "string" && !settledFrame) { error = frame.message; settledFrame = true; }
      else if (frame.type === "cancelled" && typeof frame.message === "string" && !settledFrame) { cancelled = frame.message; settledFrame = true; }
      else throw new Error("Invalid sandbox tool response");
    }
  };
  try {
    await fs.writeFile(requestPath, Buffer.from(JSON.stringify(request)), { signal });
    signal?.throwIfAborted();
    signal?.addEventListener("abort", cancel, { once: true });
    for await (const chunk of executor.exec(["node", "--input-type=module", "-e", SANDBOX_TOOL_RUNTIME, requestPath], {
      cwd: ".", timeoutSeconds: 0, onExit: exit => { exitCode = exit.exitCode; },
    })) {
      if (chunk.stream === "stdout") consume(chunk.bytes ? decoder.decode(chunk.bytes, { stream: true }) : chunk.text);
      else diagnostic = (diagnostic + chunk.text).slice(-4096);
    }
    consume(decoder.decode());
    if (cancelled !== undefined) {
      if (exitCode === undefined) throw new Error("Sandbox tool cancellation was not confirmed");
      throw new Error(cancelled);
    }
    if (error !== undefined) throw new Error(error);
    if (!accepted || exitCode !== 0 || !result || pending.trim()) throw new Error(`Sandbox Pi tool did not complete (exit ${exitCode ?? "unknown"}). ${diagnostic}`);
    return result;
  } finally {
    signal?.removeEventListener("abort", cancel);
    await cancellation;
    // The runtime unlinks before importing Pi; clean cancelled allocations as well.
    if (!accepted) {
      try {
        for await (const _ of executor.exec(["node", "-e", "require('node:fs').rmSync(process.argv[1], {force:true})", requestPath], { cwd: ".", timeoutSeconds: 5 })) { /* drain */ }
      } catch { /* an unavailable sandbox owns the remaining ephemeral file */ }
    }
  }
}
