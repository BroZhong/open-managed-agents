import { describe, expect, it } from "vitest";
import { skillBundleStorageConfigFromEnv, workspaceConfigFromEnv } from "../src/lib/workspace-config.js";

const env = {
  WORKSPACE_OSS_REGION: "oss-cn-shanghai", WORKSPACE_OSS_BUCKET: "agentry",
  WORKSPACE_OSS_ACCESS_KEY_ID: "test-id", WORKSPACE_OSS_ACCESS_KEY_SECRET: "test-secret",
  E2B_DOMAIN: "sandbox.agentry.welltop.tech", E2B_API_KEY: "test-e2b", SANDBOX_ENABLED: "true", OMA_ENVIRONMENT: "test",
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
    // Request budgets derive from the gateway's claim timeout in code (ADR-0023), not from configuration.
    expect(config.sandbox).toEqual({ domain: "sandbox.agentry.welltop.tech", apiKey: "test-e2b", defaultTemplate: "auto-story-v2" });
  });
  it("labels Sandboxes with the Runner's environment and fails startup without a valid one (ADR-0023)", () => {
    expect(workspaceConfigFromEnv(env).environment).toBe("test");
    expect(workspaceConfigFromEnv({ ...env, OMA_ENVIRONMENT: " production " }).environment).toBe("production");
    for (const value of [undefined, "", "prod", "staging", "Production"]) {
      expect(() => workspaceConfigFromEnv({ ...env, OMA_ENVIRONMENT: value })).toThrow("Sandboxes require OMA_ENVIRONMENT=production or OMA_ENVIRONMENT=test");
    }
  });
  it("rejects a disabled mount", () => {
    expect(() => workspaceConfigFromEnv({ ...env, SANDBOX_ENABLED: "false" })).toThrow("SANDBOX_ENABLED=true");
  });
  it("signs Skill install URLs for the region's internal endpoint unless configured", () => {
    expect(skillBundleStorageConfigFromEnv(env)).toMatchObject({ bucket: "agentry", internalEndpoint: "https://oss-cn-shanghai-internal.aliyuncs.com" });
    expect(skillBundleStorageConfigFromEnv({ ...env, WORKSPACE_OSS_INTERNAL_ENDPOINT: " https://oss-cn-shanghai-internal.aliyuncs.com " }).internalEndpoint)
      .toBe("https://oss-cn-shanghai-internal.aliyuncs.com");
  });
});
