import { describe, expect, it } from "vitest";
import {
  adapterProcessEnvFromHost,
  sandboxEnvPolicyFromHost,
} from "../src/lib/sandbox-env.js";

describe("sandboxEnvPolicyFromHost", () => {
  it("maps deployment variables to their in-sandbox names", () => {
    const policy = sandboxEnvPolicyFromHost({
      DEFAULT_SANDBOX_VFS_TOKEN: "vfs-token-sentinel",
      DEFAULT_SANDBOX_OPENGROVE_WW_BASE_URL: "https://ww.example.test",
      DEFAULT_SANDBOX_OPENGROVE_WW_ACCESS_TOKEN: "ww-token-sentinel",
    });

    expect(policy.defaultSandboxEnv).toEqual({
      VFS_TOKEN: "vfs-token-sentinel",
    });
    expect(policy.managedSandboxEnv).toEqual({
      OPENGROVE_WW_BASE_URL: "https://ww.example.test",
      OPENGROVE_WW_ACCESS_TOKEN: "ww-token-sentinel",
    });
  });

  it("omits missing and blank deployment variables", () => {
    expect(sandboxEnvPolicyFromHost({
      DEFAULT_SANDBOX_VFS_TOKEN: "",
      DEFAULT_SANDBOX_OPENGROVE_WW_BASE_URL: "   ",
    })).toEqual({});
  });

  it.each([
    {
      DEFAULT_SANDBOX_OPENGROVE_WW_BASE_URL: "https://ww.example.test",
    },
    {
      DEFAULT_SANDBOX_OPENGROVE_WW_ACCESS_TOKEN: "ww-token-sentinel",
    },
  ])("rejects a partial managed WW credential pair", (env) => {
    expect(() => sandboxEnvPolicyFromHost(env)).toThrow(
      "requires both DEFAULT_SANDBOX_OPENGROVE_WW_BASE_URL and " +
        "DEFAULT_SANDBOX_OPENGROVE_WW_ACCESS_TOKEN",
    );
  });
});

describe("adapterProcessEnvFromHost", () => {
  it("keeps ordinary adapter variables but removes sandbox-only deployment values", () => {
    const hostEnv = {
      PATH: "/usr/local/bin:/usr/bin",
      OPENAI_API_KEY: "adapter-key-sentinel",
      DEFAULT_SANDBOX_VFS_TOKEN: "vfs-token-sentinel",
      DEFAULT_SANDBOX_OPENGROVE_WW_BASE_URL: "https://ww.example.test",
      DEFAULT_SANDBOX_OPENGROVE_WW_ACCESS_TOKEN: "ww-token-sentinel",
    };

    expect(adapterProcessEnvFromHost(hostEnv)).toEqual({
      PATH: "/usr/local/bin:/usr/bin",
      OPENAI_API_KEY: "adapter-key-sentinel",
    });
    expect(hostEnv.DEFAULT_SANDBOX_OPENGROVE_WW_ACCESS_TOKEN).toBe(
      "ww-token-sentinel",
    );
  });
});
