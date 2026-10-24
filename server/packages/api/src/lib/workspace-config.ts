import type { OSSArtifactStoreOptions, OSSSkillBundleStoreOptions } from "@oma-server/store";
import type { SandboxEnvironment, WorkspaceMountSpec } from "@oma-server/sandbox";

type HostEnv = Readonly<Record<string, string | undefined>>;
function required(env: HostEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`OSS Workspace requires ${name}`);
  return value;
}

/** One assembly for Workspace API storage and mounted execution; no backend fallback. */
export function workspaceStorageConfigFromEnv(env: HostEnv): OSSArtifactStoreOptions {
  const region = required(env, "WORKSPACE_OSS_REGION");
  const bucket = required(env, "WORKSPACE_OSS_BUCKET");
  const oss: OSSArtifactStoreOptions = {
    region, bucket,
    accessKeyId: required(env, "WORKSPACE_OSS_ACCESS_KEY_ID"),
    accessKeySecret: required(env, "WORKSPACE_OSS_ACCESS_KEY_SECRET"),
    stsToken: env.WORKSPACE_OSS_STS_TOKEN || undefined,
    endpoint: env.WORKSPACE_OSS_ENDPOINT || `https://${region}.aliyuncs.com`,
    publicEndpoint: env.WORKSPACE_OSS_PUBLIC_ENDPOINT || `https://${region}.aliyuncs.com`,
  };
  return oss;
}

/** Skill Bundles share the Workspace Bucket and Host credentials; Sandboxes download them over the internal endpoint (ADR-0022). */
export function skillBundleStorageConfigFromEnv(env: HostEnv): OSSSkillBundleStoreOptions {
  const oss = workspaceStorageConfigFromEnv(env);
  return { ...oss, internalEndpoint: env.WORKSPACE_OSS_INTERNAL_ENDPOINT?.trim() || `https://${oss.region}-internal.aliyuncs.com` };
}

/**
 * The environment the Runner's Sandboxes belong to. Every Sandbox it creates
 * carries it as `oma.dev/environment`, and each environment's sweeper acts
 * only on its own (ADR-0023); production and test share a gateway.
 */
function sandboxEnvironmentFromEnv(env: HostEnv): SandboxEnvironment {
  const value = env.OMA_ENVIRONMENT?.trim();
  if (value !== "production" && value !== "test") throw new Error("Sandboxes require OMA_ENVIRONMENT=production or OMA_ENVIRONMENT=test");
  return value;
}

export function workspaceConfigFromEnv(env: HostEnv) {
  const oss = workspaceStorageConfigFromEnv(env);
  const bucket = oss.bucket;
  if (env.SANDBOX_ENABLED !== "true") throw new Error("OSS Workspace requires SANDBOX_ENABLED=true");
  const mount: Omit<WorkspaceMountSpec, "prefix"> = {
    bucket,
    agentName: env.WORKSPACE_OSS_AGENT_NAME || "agentry-workspace",
    pvName: env.WORKSPACE_OSS_PV_NAME || "agentry-workspace-oss",
    credentialProviderName: env.WORKSPACE_OSS_CREDENTIAL_PROVIDER || "agentry-oss-rw",
  };
  return {
    oss, mount,
    environment: sandboxEnvironmentFromEnv(env),
    sandbox: {
      domain: required(env, "E2B_DOMAIN"),
      apiKey: required(env, "E2B_API_KEY"),
      defaultTemplate: env.SANDBOX_TEMPLATE || "auto-story-v2",
    },
  };
}
