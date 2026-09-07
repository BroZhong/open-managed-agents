import { describe, expect, it } from "vitest";
import {
  adapterProcessEnvFromHost,
  sandboxEnvPolicyFromHost,
} from "../src/lib/sandbox-env.js";

describe("sandboxEnvPolicyFromHost", () => {
  it("scopes auto-story credentials to allowed Agent ids without persisting defaults", () => {
    const policy = sandboxEnvPolicyFromHost({
      AUTO_STORY_AGENT_IDS: "agent_story, agent_story, agent_second",
      AUTO_STORY_SANDBOX_ENV_JSON: JSON.stringify({
        MEDIAKIT_API_KEY: "media-sentinel", GEMINI_API_KEY: "gemini-sentinel",
        VFS_TOKEN: "vfs-sentinel", CUSTOM_OPTION: "preserved",
      }),
    });
    expect(policy.defaultSandboxEnv).toBeUndefined();
    expect(Object.keys(policy.managedSandboxEnvByAgentId!)).toEqual(["agent_story", "agent_second"]);
    expect(policy.managedSandboxEnvByAgentId!.agent_story).toEqual({
      MEDIAKIT_API_KEY: "media-sentinel", GEMINI_API_KEY: "gemini-sentinel",
      VFS_TOKEN: "vfs-sentinel", CUSTOM_OPTION: "preserved",
      MEDIAKIT_SURFACE: "skill", MEDIAKIT_RUNTIME: "pi-agent",
    });
    expect(policy.managedSandboxEnvByAgentId!.agent_unrelated).toBeUndefined();
  });

  it.each([undefined, "{secret-sentinel", "[]", "null", '{"BAD-NAME":"secret-sentinel"}', '{"VALID":42}'])
  ("rejects malformed auto-story configuration without disclosing its value", (json) => {
    const env = { AUTO_STORY_AGENT_IDS: "agent_story", AUTO_STORY_SANDBOX_ENV_JSON: json };
    expect(() => sandboxEnvPolicyFromHost(env)).toThrow(/AUTO_STORY/);
    try { sandboxEnvPolicyFromHost(env); } catch (error) {
      expect(String(error)).not.toContain("secret-sentinel");
    }
  });

  it("requires an Agent allowlist when auto-story credentials are configured", () => {
    expect(() => sandboxEnvPolicyFromHost({ AUTO_STORY_SANDBOX_ENV_JSON: "{}" }))
      .toThrow("AUTO_STORY_AGENT_IDS");
  });
  it("maps deployment variables to their in-sandbox names", () => {
    const policy = sandboxEnvPolicyFromHost({
      DEFAULT_SANDBOX_VFS_TOKEN: "vfs-token-sentinel",
      DEFAULT_SANDBOX_OPENGROVE_WW_BASE_URL: "https://ww.example.test",
      DEFAULT_SANDBOX_OPENGROVE_WW_ACCESS_TOKEN: "ww-token-sentinel",
      DEFAULT_SANDBOX_OPENGROVE_WW_AGENT_IDS: "agent_story, agent_backup",
    });

    expect(policy.defaultSandboxEnv).toEqual({
      VFS_TOKEN: "vfs-token-sentinel",
    });
    expect(policy.managedSandboxEnvByAgentId).toEqual({
      agent_story: {
        OPENGROVE_WW_BASE_URL: "https://ww.example.test",
        OPENGROVE_WW_ACCESS_TOKEN: "ww-token-sentinel",
      },
      agent_backup: {
        OPENGROVE_WW_BASE_URL: "https://ww.example.test",
        OPENGROVE_WW_ACCESS_TOKEN: "ww-token-sentinel",
      },
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
      DEFAULT_SANDBOX_OPENGROVE_WW_AGENT_IDS: "agent_story",
      AUTO_STORY_AGENT_IDS: "agent_story",
      AUTO_STORY_SANDBOX_ENV_JSON: '{"GEMINI_API_KEY":"gemini-sentinel"}',
    },
    {
      DEFAULT_SANDBOX_OPENGROVE_WW_ACCESS_TOKEN: "ww-token-sentinel",
      DEFAULT_SANDBOX_OPENGROVE_WW_AGENT_IDS: "agent_story",
    },
    {
      DEFAULT_SANDBOX_OPENGROVE_WW_BASE_URL: "https://ww.example.test",
      DEFAULT_SANDBOX_OPENGROVE_WW_ACCESS_TOKEN: "ww-token-sentinel",
    },
  ])("rejects a partial managed WW configuration", (env) => {
    expect(() => sandboxEnvPolicyFromHost(env)).toThrow(
      "requires DEFAULT_SANDBOX_OPENGROVE_WW_BASE_URL, " +
        "DEFAULT_SANDBOX_OPENGROVE_WW_ACCESS_TOKEN, and " +
        "DEFAULT_SANDBOX_OPENGROVE_WW_AGENT_IDS",
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
      DEFAULT_SANDBOX_OPENGROVE_WW_AGENT_IDS: "agent_story",
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
