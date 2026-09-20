import fs from "node:fs";
import fsp from "node:fs/promises";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { afterEach, describe, it, expect, vi } from "vitest";
import { buildCustomTools } from "../src/custom-tools.js";
import { ProtocolExecutor } from "./sandbox-protocol-fixture.js";
afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); });
describe("all seven tools stay behind ToolExecutor", () => {
  it.each(["bash", "read", "write", "edit", "ls", "grep", "find"])("%s never probes Host files or spawns Host processes", async name => {
    const executor = new ProtocolExecutor();
    const forbidden = () => { throw new Error("HOST_IO_FORBIDDEN"); };
    const spies = [vi.spyOn(fs, "accessSync"), vi.spyOn(fs, "realpathSync"), vi.spyOn(fs, "readFileSync"), vi.spyOn(fs, "createWriteStream"), vi.spyOn(fsp, "access"), vi.spyOn(fsp, "realpath"), vi.spyOn(fsp, "readFile"), vi.spyOn(fsp, "writeFile"), vi.spyOn(cp, "spawn"), vi.spyOn(cp, "exec")];
    for (const spy of spies) spy.mockImplementation(forbidden);
    syncBuiltinESMExports();
    const tool = buildCustomTools(executor).find(tool => tool.name === name)!;
    tool.renderCall?.({ path: "note.txt" }, {} as never, {} as never);
    await tool.execute("boundary", { path: "note.txt", content: "hello", edits: [{ oldText: "a", newText: "b" }], command: "pwd", pattern: "*" } as never, undefined, undefined, {} as never);
    expect(executor.requests[0].name).toBe(name);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
