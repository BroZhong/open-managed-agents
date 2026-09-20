import { describe, it, expect, vi } from "vitest";
import { ExecAbortedBeforeStartError } from "@open-managed-agents/adapter-core";
import { ProtocolExecutor, invoke, result } from "./sandbox-protocol-fixture.js";

describe("sandbox native tool protocol", () => {
  it("decodes split UTF-8 and returns native details unchanged", async () => {
    expect(await invoke(new ProtocolExecutor())).toEqual(result);
  });
  it.each([undefined, 2])("rejects a result without successful exit (%s)", async code => {
    const executor = new ProtocolExecutor(); executor.exitCode = code;
    await expect(invoke(executor)).rejects.toThrow("did not complete");
  });
  it("preserves runtime failures instead of falling back to Host", async () => {
    const executor = new ProtocolExecutor(); executor.frames = [{ type: "accepted", pid: 123 }, { type: "error", message: "Sandbox Pi version mismatch" }]; executor.exitCode = 1;
    await expect(invoke(executor)).rejects.toThrow("version mismatch");
    expect(executor.commands).toHaveLength(1);
  });
  it("rejects malformed frames and cleans unaccepted requests", async () => {
    const executor = new ProtocolExecutor(); executor.frames = ["not JSON"];
    await expect(invoke(executor)).rejects.toThrow();
    expect(executor.commands.at(-1)?.[1]).toBe("-e");
  });
  it("delivers native progress", async () => {
    const executor = new ProtocolExecutor(); const update = vi.fn();
    executor.frames = [{ type: "accepted", pid: 123 }, { type: "update", result }, { type: "result", result }];
    await invoke(executor, "bash", { command: "printf hello" }, undefined, update);
    expect(update).toHaveBeenCalledWith(result);
  });
  it.each(["~/workspace/note.txt", "/home/user/workspace/note.txt", "@@note.txt", "file:///tmp/note.txt"])("preserves native path syntax %s", async path => {
    const executor = new ProtocolExecutor(); await invoke(executor, "read", { path });
    expect(executor.requests[0].args.path).toBe(path);
  });
  it("keeps absolute projections", async () => {
    const executor = new ProtocolExecutor(); await invoke(executor, "read", { path: "/skills/story/SKILL.md" });
    expect(executor.requests[0].args.path).toBe("/skills/story/SKILL.md");
  });
  it("does not turn an unconfirmed transport failure into cancellation", async () => {
    const executor = new ProtocolExecutor(); const controller = new AbortController();
    executor.exitCode = undefined; executor.failure = new Error("RPC disconnected");
    executor.afterFrames = async () => controller.abort();
    await expect(invoke(executor, "read", {}, controller.signal)).rejects.toThrow("RPC disconnected");
  });
  it("requires a settled native cancellation frame, not just an exited wrapper", async () => {
    const executor = new ProtocolExecutor();
    executor.frames = [{ type: "accepted", pid: 123 }, { type: "cancelled", message: "Command aborted" }];
    executor.exitCode = 1;
    await expect(invoke(executor)).rejects.toThrow("Command aborted");
    executor.exitCode = undefined;
    await expect(invoke(executor)).rejects.toThrow("not confirmed");
  });
});
