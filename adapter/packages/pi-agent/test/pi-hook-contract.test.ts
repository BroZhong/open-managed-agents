import assert from "node:assert/strict";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, it, vi } from "vitest";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
function execute<Args, Result>(tool: {
  execute: (id: string, args: Args, signal: undefined, onUpdate: undefined, ctx: never) => Promise<Result>;
}, args: Args): Promise<Result> {
  return tool.execute("hook-contract", args, undefined, undefined, {} as never);
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
});

describe("pinned Pi native I/O hook contract", () => {
  it("awaits async spill creation, preserves mutable raw bytes, orders writes, and avoids Host files", async () => {
    vi.spyOn(os, "tmpdir").mockImplementation(() => { throw new Error("Host tmpdir"); });
    vi.spyOn(fs, "createWriteStream").mockImplementation(() => { throw new Error("Host write"); });
    syncBuiltinESMExports();
    const ready = deferred();
    const chunks: Buffer[] = [];
    let closes = 0;
    let active = 0;
    const tail = Buffer.alloc(60_000, 0x78);
    const tool = createBashToolDefinition("/remote", {
      env: {},
      operations: {
        async exec(_command, _cwd, { onData }) {
          const first = Buffer.from([0xe4, 0xb8, 0xad]);
          onData(first); first.fill(0);
          const second = Buffer.from([0xff, 0x0a, 0x32]);
          onData(second); second.fill(0);
          onData(tail);
          ready.resolve();
          return { exitCode: 0 };
        },
      },
      async createOutputSink() {
        await ready.promise;
        return {
          path: "/sandbox/full.log",
          async write(chunk) {
            assert.equal(active++, 0);
            await tick();
            chunks.push(chunk);
            active--;
          },
          close() { closes++; },
        };
      },
    });
    const result = await execute(tool, { command: "remote-output" });
    assert.equal(closes, 1);
    assert.equal(result.details?.fullOutputPath, "/sandbox/full.log");
    assert.deepEqual(Buffer.concat(chunks), Buffer.concat([
      Buffer.from([0xe4, 0xb8, 0xad, 0xff, 0x0a, 0x32]), tail,
    ]));
  });

  it.each(["factory", "write", "close"])("propagates asynchronous %s failure and closes a created sink once", async (failure) => {
    let closes = 0;
    const tool = createBashToolDefinition("/remote", {
      env: {},
      operations: {
        async exec(_command, _cwd, { onData }) {
          onData(Buffer.alloc(60_000, 0x61));
          onData(Buffer.from("later"));
          // A rejection before process completion must not become unhandled.
          await tick();
          return { exitCode: 0 };
        },
      },
      async createOutputSink() {
        if (failure === "factory") throw new Error(failure);
        return {
          path: "/remote/log",
          async write() { if (failure === "write") throw new Error(failure); },
          async close() { closes++; if (failure === "close") throw new Error(failure); },
        };
      },
    });
    await assert.rejects(execute(tool, { command: "output" }), new RegExp(failure));
    assert.equal(closes, failure === "factory" ? 0 : 1);
  });

  it("does not allocate output storage for a short command", async () => {
    const createOutputSink = vi.fn(async () => ({ path: "/unused", write() {}, close() {} }));
    const tool = createBashToolDefinition("/remote", {
      env: {}, createOutputSink,
      operations: { async exec(_command, _cwd, { onData }) { onData(Buffer.from("short")); return { exitCode: 0 }; } },
    });
    assert.deepEqual((await execute(tool, { command: "short" })).content, [{ type: "text", text: "short" }]);
    assert.equal(createOutputSink.mock.calls.length, 0);
  });

  it("isolates mutation scopes and serializes symlink aliases without Host realpath", async () => {
    vi.spyOn(fsPromises, "realpath").mockImplementation(async () => { throw new Error("Host realpath"); });
    syncBuiltinESMExports();
    const scope = {};
    const events: string[] = [];
    const held = deferred();
    const one = withFileMutationQueue("/remote/link", async () => {
      events.push("first"); await held.promise; events.push("first done");
    }, { scope, realpath: async () => "/remote/target" });
    const two = withFileMutationQueue("/remote/target", async () => {
      events.push("second");
    }, { scope, realpath: async () => "/remote/target" });
    try {
      await tick();
      assert.deepEqual(events, ["first"]);
      await withFileMutationQueue("/remote/target", async () => {
        events.push("other scope");
      }, { scope: {}, realpath: async () => "/remote/target" });
      await withFileMutationQueue("/remote/noprobe", async () => {}, { scope: {} });
    } finally {
      held.resolve();
      await Promise.all([one, two]);
    }
    assert.deepEqual(events, ["first", "other scope", "first done", "second"]);
  });

  it("uses F_OK candidate existence and remote Unicode/home paths before readability", async () => {
    vi.spyOn(fsPromises, "access").mockImplementation(async () => { throw new Error("Host access"); });
    syncBuiltinESMExports();
    const expected = "/remote/home/café.txt".normalize("NFD");
    const probes: string[] = [];
    const tool = createReadToolDefinition("/remote/cwd", {
      homeDir: "/remote/home",
      operations: {
        exists: async (path) => { probes.push(path); return path === expected; },
        access: async (path) => { assert.equal(path, expected); },
        readFile: async (path) => { assert.equal(path, expected); return Buffer.from("ok"); },
      },
    });
    assert.deepEqual((await execute(tool, { path: "~/café.txt" })).content, [{ type: "text", text: "ok" }]);
    assert.deepEqual(probes, ["/remote/home/café.txt", expected]);
    const denied = createReadToolDefinition("/remote", {
      operations: {
        exists: async () => true,
        access: async () => { throw new Error("remote EACCES"); },
        readFile: async () => { throw new Error("unexpected read"); },
      },
    });
    await assert.rejects(execute(denied, { path: "café.txt" }), /remote EACCES/);
  });

  it("validates timeout before calling a custom backend and honors an empty explicit environment", async () => {
    const backend = vi.fn(async (_command: string, _cwd: string, options: { env?: NodeJS.ProcessEnv }) => {
      assert.deepEqual(options.env, {});
      return { exitCode: 0 };
    });
    const tool = createBashToolDefinition("/remote", { env: {}, operations: { exec: backend } });
    for (const timeout of [0, -1, NaN, Infinity, 2_147_483.648]) {
      await assert.rejects(execute(tool, { command: "true", timeout }), /Invalid timeout/);
    }
    assert.equal(backend.mock.calls.length, 0);
    await execute(tool, { command: "true" });
    assert.equal(backend.mock.calls.length, 1);
  });

  it("renders edit previews through remote read access with no Host read", async () => {
    vi.spyOn(fsPromises, "access").mockImplementation(async () => { throw new Error("Host access"); });
    vi.spyOn(fsPromises, "readFile").mockImplementation(async () => { throw new Error("Host read"); });
    syncBuiltinESMExports();
    const modes: Array<number | undefined> = [];
    const reads: string[] = [];
    const tool = createEditToolDefinition("/remote/cwd", {
      homeDir: "/remote/home", mutationScope: {},
      operations: {
        access: async (path, mode) => { assert.equal(path, "/remote/home/story.txt"); modes.push(mode); },
        readFile: async (path) => { reads.push(path); return Buffer.from("old story\n"); },
        writeFile: async () => { throw new Error("Preview must not write"); },
      },
    });
    const invalidated = deferred();
    const state: { callComponent?: { preview?: { diff?: string; error?: string } } } = {};
    const theme = { fg: (_name: string, text: string) => text, bg: (_name: string, text: string) => text,
      bold: (text: string) => text };
    tool.renderCall!({ path: "~/story.txt", edits: [{ oldText: "old", newText: "new" }] }, theme as never, {
      state, cwd: "/remote/cwd", argsComplete: true, invalidate: invalidated.resolve,
    } as never);
    await invalidated.promise;
    assert.deepEqual(modes, [fs.constants.R_OK]);
    assert.deepEqual(reads, ["/remote/home/story.txt"]);
    assert.equal(state.callComponent?.preview?.error, undefined);
    assert.match(state.callComponent?.preview?.diff ?? "", /new story/);
  });
});
