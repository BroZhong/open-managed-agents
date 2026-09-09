import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { CommandHandle } from "e2b";
import { beforeAll, describe, expect, it } from "vitest";

type CommandHandleConstructor = typeof CommandHandle;
type EventStream = ConstructorParameters<CommandHandleConstructor>[3];
type ProcessEvent = EventStream extends AsyncIterable<infer Event> ? Event : never;

const require = createRequire(import.meta.url);
let handles: Record<"cjs" | "esm", CommandHandleConstructor>;

beforeAll(async () => {
  // Exercise both published runtime bundles, not a replacement decoder or a
  // mocked Sandbox. Node and bundlers can select different SDK entrypoints.
  const cjs = require("e2b") as typeof import("e2b");
  const esm = await import(new URL("./index.mjs", pathToFileURL(require.resolve("e2b"))).href) as typeof import("e2b");
  // CommandHandle is exported by the declarations but not the JS bundles.
  // Obtain each bundle's real constructor through Commands.run; only the RPC
  // event source is replaced, so setup, parsing, callbacks and wait are real.
  const constructor = async (sdk: typeof import("e2b")) => {
    const sandbox = new sdk.Sandbox({ sandboxId: "decoder-test", envdVersion: "0.2.0", domain: "invalid" });
    Object.defineProperty(sandbox.commands, "rpc", { value: { start: () => events([], 0) } });
    const handle = await sandbox.commands.run("true", { background: true, timeoutMs: 0 });
    await handle.wait();
    return handle.constructor as CommandHandleConstructor;
  };
  handles = { cjs: await constructor(cjs), esm: await constructor(esm) };
});

function data(stream: "stdout" | "stderr" | "pty", bytes: number[]): ProcessEvent {
  return {
    $typeName: "process.StartResponse",
    event: {
      $typeName: "process.ProcessEvent",
      event: {
        case: "data",
        value: {
          $typeName: "process.ProcessEvent.DataEvent",
          output: { case: stream, value: Uint8Array.from(bytes) },
        },
      },
    },
  };
}

async function* events(chunks: ProcessEvent[], exitCode: number): EventStream {
  yield {
    $typeName: "process.StartResponse",
    event: {
      $typeName: "process.ProcessEvent",
      event: { case: "start", value: { $typeName: "process.ProcessEvent.StartEvent", pid: 123 } },
    },
  };
  yield* chunks;
  yield {
    $typeName: "process.StartResponse",
    event: {
      $typeName: "process.ProcessEvent",
      event: {
        case: "end",
        value: {
          $typeName: "process.ProcessEvent.EndEvent",
          exitCode, exited: true, status: "exited",
        },
      },
    },
  };
}

function run(kind: "cjs" | "esm", chunks: ProcessEvent[], exitCode = 0) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const pty: Uint8Array[] = [];
  const handle = new handles[kind](
    123, () => {}, async () => true, events(chunks, exitCode),
    (text) => { stdout.push(text); },
    (text) => { stderr.push(text); },
    (bytes) => { pty.push(bytes); },
  );
  return { handle, stdout, stderr, pty };
}

describe.each(["cjs", "esm"] as const)("real E2B CommandHandle %s streaming", (kind) => {
  it("preserves three- and four-byte Unicode split across transport events", async () => {
    const { handle, stdout } = run(kind, [
      data("stdout", [0xe4]),
      data("stdout", [0xb8, 0xad, 0xf0, 0x9f]),
      data("stdout", [0x98]),
      data("stdout", [0x80, 0x0a]),
    ]);
    expect(await handle.wait()).toMatchObject({ stdout: "中😀\n", stderr: "", exitCode: 0 });
    expect(stdout.join("")).toBe("中😀\n");
  });

  it("keeps independent decoding state for interleaved stdout and stderr", async () => {
    const { handle, stdout, stderr } = run(kind, [
      data("stdout", [0xe4]),
      data("stderr", [0xc3]),
      data("stdout", [0xb8, 0xad]),
      data("stderr", [0xa9, 0xe7]),
      data("stdout", [0xf0, 0x9f]),
      data("stderr", [0x95, 0x8c]),
      data("stdout", [0x98, 0x80]),
    ]);
    expect(await handle.wait()).toMatchObject({ stdout: "中😀", stderr: "é界" });
    expect(stdout.join("")).toBe("中😀");
    expect(stderr.join("")).toBe("é界");
  });

  it("preserves leading BOM bytes and a BOM beginning a later chunk", async () => {
    const { handle, stdout } = run(kind, [
      data("stdout", [0xef]),
      data("stdout", [0xbb, 0xbf, 0x61]),
      data("stdout", [0xef, 0xbb, 0xbf, 0x62]),
    ]);
    expect(await handle.wait()).toMatchObject({ stdout: "\uFEFFa\uFEFFb" });
    expect(stdout.join("")).toBe("\uFEFFa\uFEFFb");
  });

  it("flushes an incomplete final sequence before constructing the exit result", async () => {
    const { handle, stdout, stderr } = run(kind, [
      data("stdout", [0x61, 0xe4, 0xb8]),
      data("stderr", [0x62, 0xf0, 0x9f, 0x98]),
    ]);
    expect(await handle.wait()).toMatchObject({ stdout: "a�", stderr: "b�" });
    expect(stdout.join("")).toBe("a�");
    expect(stderr.join("")).toBe("b�");
  });

  it("keeps the final decoded output on a nonzero exit", async () => {
    const { handle, stdout, stderr } = run(kind, [
      data("stdout", [0xe4]), data("stdout", [0xb8, 0xad]),
      data("stderr", [0x65, 0xe4]),
    ], 2);
    await expect(handle.wait()).rejects.toMatchObject({ exitCode: 2, stdout: "中", stderr: "e�" });
    expect(stdout.join("")).toBe("中");
    expect(stderr.join("")).toBe("e�");
  });

  it("passes PTY bytes through without text decoding", async () => {
    const { handle, pty } = run(kind, [data("pty", [0x00, 0xe4, 0xff])]);
    expect(await handle.wait()).toMatchObject({ stdout: "", stderr: "" });
    expect(pty).toEqual([Uint8Array.from([0x00, 0xe4, 0xff])]);
  });
});
