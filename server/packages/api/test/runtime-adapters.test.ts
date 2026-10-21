import { describe, expect, it } from "vitest";
import type { Adapter } from "@open-managed-agents/adapter-core";
import { runtimeAdapters } from "../src/lib/runtime-adapters.js";

const adapter = (): Adapter => ({ async *run() {} });

describe("Runner runtime adapters", () => {
  it("run only the wired runtimes; retired and unknown runtimes stay unresolved", () => {
    const piAgent = adapter();
    const mock = adapter();
    const resolve = runtimeAdapters({ "pi-agent": piAgent, mock });

    expect(resolve("pi-agent")).toBe(piAgent);
    expect(resolve("mock")).toBe(mock);
    for (const runtime of ["claude-code", "codex", "unknown", "constructor"]) {
      expect(resolve(runtime)).toBeUndefined();
    }
    expect(runtimeAdapters({ mock })("pi-agent")).toBeUndefined();
  });
});
