import type { OSSArtifactStoreOptions } from "@oma-server/store";
import type { WorkspaceMountSpec } from "@oma-server/sandbox";

type HostEnv = Readonly<Record<string, string | undefined>>;
function required(env: HostEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`OSS Workspace requires ${name}`);
  return value;
}

/** One assembly for Workspace API storage and mounted execution; no backend fallback. */
export function workspaceConfigFromEnv(env: HostEnv) {
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
  if (env.SANDBOX_ENABLED !== "true") throw new Error("OSS Workspace requires SANDBOX_ENABLED=true");
  const requestTimeoutMs = Number(env.E2B_REQUEST_TIMEOUT_MS ?? 185_000);
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs < 180_000 || requestTimeoutMs > 300_000) {
    throw new Error("E2B_REQUEST_TIMEOUT_MS must be between 180000 and 300000 for the ALB 180-second window");
  }
  const mount: Omit<WorkspaceMountSpec, "prefix"> = {
    bucket,
    agentName: env.WORKSPACE_OSS_AGENT_NAME || "agentry-workspace",
    pvName: env.WORKSPACE_OSS_PV_NAME || "agentry-workspace-oss",
    credentialProviderName: env.WORKSPACE_OSS_CREDENTIAL_PROVIDER || "agentry-oss-rw",
  };
  return {
    oss, mount,
    sandbox: {
      domain: required(env, "E2B_DOMAIN"),
      apiKey: required(env, "E2B_API_KEY"),
      defaultTemplate: env.SANDBOX_TEMPLATE || "auto-story-v2",
      requestTimeoutMs,
    },
  };
}
