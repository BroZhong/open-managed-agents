import { describe, expect, it } from "vitest";
import { workspaceConfigFromEnv } from "../src/lib/workspace-config.js";

const env = {
  WORKSPACE_OSS_REGION: "oss-cn-shanghai", WORKSPACE_OSS_BUCKET: "agentry",
  WORKSPACE_OSS_ACCESS_KEY_ID: "test-id", WORKSPACE_OSS_ACCESS_KEY_SECRET: "test-secret",
  E2B_DOMAIN: "sandbox.agentry.welltop.tech", E2B_API_KEY: "test-e2b", SANDBOX_ENABLED: "true",
};

describe("OSS Workspace startup configuration", () => {
  it("fails before startup when Workspace credentials are absent even with Supabase configured", () => {
    expect(() => workspaceConfigFromEnv({ S3_ENDPOINT: "https://skills", SUPABASE_SERVICE_KEY: "skills-key" }))
      .toThrow("WORKSPACE_OSS_REGION");
  });
  it("assembles public OSS signing and the Shanghai mount independently of Skills", () => {
    const config = workspaceConfigFromEnv({ ...env, WORKSPACE_OSS_ENDPOINT: "https://oss-cn-shanghai-internal.aliyuncs.com", S3_BUCKET: "skills" });
    expect(config.oss.bucket).toBe("agentry");
    expect(config.oss.publicEndpoint).toBe("https://oss-cn-shanghai.aliyuncs.com");
    expect(config.mount).toEqual({ bucket: "agentry", agentName: "agentry-workspace", pvName: "agentry-workspace-oss", credentialProviderName: "agentry-oss-rw" });
    expect(config.sandbox.requestTimeoutMs).toBe(185000);
    expect(config.sandbox.defaultTemplate).toBe("auto-story-v2");
  });
  it("rejects a disabled mount and an SDK request deadline below the ALB window", () => {
    expect(() => workspaceConfigFromEnv({ ...env, SANDBOX_ENABLED: "false" })).toThrow("SANDBOX_ENABLED=true");
    expect(() => workspaceConfigFromEnv({ ...env, E2B_REQUEST_TIMEOUT_MS: "60000" })).toThrow("180000");
  });
});
