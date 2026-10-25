import type { EnvironmentBaseImage, OSSArtifactStoreOptions } from "@oma-server/store";
import { isDigestPinnedImage, PLATFORM_DEFAULT_ENV, type SandboxEnvironment } from "@oma-server/sandbox";
import { sandboxEnvironmentFromEnv, workspaceStorageConfigFromEnv } from "../lib/workspace-config.js";

type HostEnv = Readonly<Record<string, string | undefined>>;

/** Everything `oma-image-builder` is configured with; nothing about images is in code. */
export interface ImageBuilderConfig {
  /** `OMA_ENVIRONMENT`: the image tag's prefix and the label of its pods and verification Sandboxes. */
  environment: SandboxEnvironment;
  /** `BUILD_NAMESPACE`: where build pods run (the builder's own namespace). */
  namespace: string;
  /** `ENVIRONMENT_IMAGE_REPOSITORY`: where Environment images are pushed. */
  repository: string;
  /** `BASE_IMAGE_OMA_BASE`, `BASE_IMAGE_OMA_MEDIA`: the Base Images, pinned by digest. */
  baseImages: Record<EnvironmentBaseImage, string>;
  /** `BUILDAH_IMAGE`: buildah, pinned by digest. */
  buildahImage: string;
  /** `BUILD_REGISTRY_AUTH_SECRET`: the dockerconfigjson Secret build pods push with. */
  registryAuthSecret: string;
  /** `BUILD_IMAGE_PULL_SECRET`: pulls the buildah image. */
  imagePullSecret: string;
  /** `BUILD_PROXY_URL` and `BUILD_NO_PROXY`: the build-time egress proxy, both or neither. */
  proxy: { url: string; noProxy: string } | null;
  platformDefaults: Readonly<Record<string, string>>;
  /** `E2B_DOMAIN`, `E2B_API_KEY`, `SANDBOX_TEMPLATE`: the gateway and the Warm Pool verification claims from. */
  sandbox: { domain: string; apiKey: string; pool: string };
  /** The Host Bucket that keeps build logs (`WORKSPACE_OSS_*`). */
  oss: OSSArtifactStoreOptions;
}

function required(env: HostEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`oma-image-builder requires ${name}`);
  return value;
}

function pinned(env: HostEnv, name: string): string {
  const value = required(env, name);
  if (!isDigestPinnedImage(value)) throw new Error(`${name} must be an image pinned by digest (<repository>@sha256:<hex>)`);
  return value;
}

const KUBERNETES_NAME = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;

export function imageBuilderConfigFromEnv(env: HostEnv): ImageBuilderConfig {
  const repository = required(env, "ENVIRONMENT_IMAGE_REPOSITORY");
  if (!/^[a-z0-9.-]+(?::\d+)?\/[a-z0-9]+(?:[._/-][a-z0-9]+)*$/.test(repository)) {
    throw new Error("ENVIRONMENT_IMAGE_REPOSITORY must be a repository without tag or digest");
  }
  const names = Object.fromEntries(["BUILD_NAMESPACE", "BUILD_REGISTRY_AUTH_SECRET", "BUILD_IMAGE_PULL_SECRET"].map((name) => {
    const value = required(env, name);
    if (!KUBERNETES_NAME.test(value)) throw new Error(`${name} must be a Kubernetes name`);
    return [name, value];
  }));
  const proxyUrl = env.BUILD_PROXY_URL?.trim();
  const noProxy = env.BUILD_NO_PROXY?.trim();
  if (!proxyUrl !== !noProxy) throw new Error("BUILD_PROXY_URL and BUILD_NO_PROXY are set together: without an explicit NO_PROXY the Aliyun mirrors would go through the proxy");
  if (proxyUrl && !/^https?:\/\/[^\s/@]+(?::\d+)?\/?$/.test(proxyUrl)) throw new Error("BUILD_PROXY_URL must be an http(s) URL without credentials");
  return {
    environment: sandboxEnvironmentFromEnv(env),
    namespace: names.BUILD_NAMESPACE!,
    repository,
    baseImages: { "oma-base": pinned(env, "BASE_IMAGE_OMA_BASE"), "oma-media": pinned(env, "BASE_IMAGE_OMA_MEDIA") },
    buildahImage: pinned(env, "BUILDAH_IMAGE"),
    registryAuthSecret: names.BUILD_REGISTRY_AUTH_SECRET!,
    imagePullSecret: names.BUILD_IMAGE_PULL_SECRET!,
    proxy: proxyUrl && noProxy ? { url: proxyUrl, noProxy } : null,
    platformDefaults: PLATFORM_DEFAULT_ENV,
    sandbox: { domain: required(env, "E2B_DOMAIN"), apiKey: required(env, "E2B_API_KEY"), pool: required(env, "SANDBOX_TEMPLATE") },
    oss: workspaceStorageConfigFromEnv(env),
  };
}
