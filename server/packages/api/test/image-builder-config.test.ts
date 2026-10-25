import { describe, expect, it } from "vitest";
import { imageBuilderConfigFromEnv } from "../src/image-builder/config.js";

const pinned = (repo: string, c: string) => `registry-vpc.cn-shanghai.aliyuncs.com/welltop/${repo}@sha256:${c.repeat(64)}`;
const env = {
  OMA_ENVIRONMENT: "test",
  BUILD_NAMESPACE: "oma-test",
  ENVIRONMENT_IMAGE_REPOSITORY: "registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-environments",
  BASE_IMAGE_OMA_BASE: pinned("oma-sandbox", "1"),
  BASE_IMAGE_OMA_MEDIA: pinned("oma-sandbox", "2"),
  BUILDAH_IMAGE: pinned("buildah", "3"),
  BUILD_REGISTRY_AUTH_SECRET: "ali-shanghai",
  BUILD_IMAGE_PULL_SECRET: "ali-shanghai",
  BUILD_PROXY_URL: "http://sing-box.oma-infra.svc.cluster.local:7890",
  BUILD_NO_PROXY: "localhost,127.0.0.1,.aliyuncs.com",
  E2B_DOMAIN: "sandbox.example", E2B_API_KEY: "key", SANDBOX_TEMPLATE: "oma-test-sandbox",
  WORKSPACE_OSS_REGION: "oss-cn-shanghai", WORKSPACE_OSS_BUCKET: "agentry",
  WORKSPACE_OSS_ACCESS_KEY_ID: "id", WORKSPACE_OSS_ACCESS_KEY_SECRET: "secret",
  BUILTIN_ENVIRONMENTS_DIR: "/app/sandbox/environments",
  WARM_POOL_ENVIRONMENT: "env_video_production",
  WARM_POOL_NAMESPACE: "sandbox-system",
  WARM_POOL_IMAGE_CACHE: "none",
};
const acs = {
  WARM_POOL_IMAGE_CACHE: "acs", ALIYUN_REGION: "cn-shanghai",
  IMAGE_CACHE_SECURITY_GROUP_ID: "sg-uf6bikdzvy9di9y8wp89", IMAGE_CACHE_VSWITCH_IDS: "vsw-uf6kw2gmpn1psc4yqpgqa, vsw-uf6xsc4rp8k5cpjgcelmu",
  IMAGE_CACHE_ACCESS_KEY_ID: "cache-id", IMAGE_CACHE_ACCESS_KEY_SECRET: "cache-secret",
};

describe("imageBuilderConfigFromEnv", () => {
  it("reads the Base Images, buildah, the registry target, the proxy and the gateway from configuration", () => {
    expect(imageBuilderConfigFromEnv(env)).toMatchObject({
      environment: "test", namespace: "oma-test",
      repository: "registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-environments",
      baseImages: { "oma-base": env.BASE_IMAGE_OMA_BASE, "oma-media": env.BASE_IMAGE_OMA_MEDIA },
      buildahImage: env.BUILDAH_IMAGE, registryAuthSecret: "ali-shanghai", imagePullSecret: "ali-shanghai",
      proxy: { url: env.BUILD_PROXY_URL, noProxy: env.BUILD_NO_PROXY },
      platformDefaults: { PIP_INDEX_URL: "https://mirrors.aliyun.com/pypi/simple/" },
      sandbox: { domain: "sandbox.example", apiKey: "key", pool: "oma-test-sandbox" },
      oss: { bucket: "agentry" },
    });
    expect(imageBuilderConfigFromEnv({ ...env, BUILD_PROXY_URL: "", BUILD_NO_PROXY: "" }).proxy).toBeNull();
  });

  it("keeps the Warm Pool on an Environment's image only when told how to cache it", () => {
    expect(imageBuilderConfigFromEnv(env)).toMatchObject({
      builtInEnvironmentsDir: "/app/sandbox/environments",
      warmPool: { environmentId: "env_video_production", namespace: "sandbox-system", name: "oma-test-sandbox", imageCache: null },
    });
    expect(imageBuilderConfigFromEnv({ ...env, WARM_POOL_ENVIRONMENT: "" }).warmPool).toBeNull();
    expect(imageBuilderConfigFromEnv({ ...env, ...acs }).warmPool).toEqual({
      environmentId: "env_video_production", namespace: "sandbox-system", name: "oma-test-sandbox",
      imageCache: {
        regionId: "cn-shanghai", securityGroupId: "sg-uf6bikdzvy9di9y8wp89", vSwitchIds: ["vsw-uf6kw2gmpn1psc4yqpgqa", "vsw-uf6xsc4rp8k5cpjgcelmu"],
        environment: "test", accessKeyId: "cache-id", accessKeySecret: "cache-secret",
      },
    });
    for (const [change, message] of [
      [{ WARM_POOL_IMAGE_CACHE: "" }, "WARM_POOL_IMAGE_CACHE must be acs"],
      [{ WARM_POOL_IMAGE_CACHE: "auto" }, "WARM_POOL_IMAGE_CACHE must be acs"],
      [{ WARM_POOL_NAMESPACE: "" }, "requires WARM_POOL_NAMESPACE"],
      [{ WARM_POOL_ENVIRONMENT: "video-production" }, "Built-in Environment's id"],
      [{ ...acs, IMAGE_CACHE_ACCESS_KEY_SECRET: "" }, "requires IMAGE_CACHE_ACCESS_KEY_SECRET"],
      [{ ...acs, IMAGE_CACHE_VSWITCH_IDS: "subnet-1" }, "vSwitch ids"],
      [{ ...acs, IMAGE_CACHE_SECURITY_GROUP_ID: "x" }, "security group id"],
      [{ BUILTIN_ENVIRONMENTS_DIR: "" }, "requires BUILTIN_ENVIRONMENTS_DIR"],
    ] as const) {
      expect(() => imageBuilderConfigFromEnv({ ...env, ...change }), message).toThrow(message);
    }
  });

  it.each([
    [{ BASE_IMAGE_OMA_MEDIA: "registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-sandbox:oma-media-0.1.2" }, "BASE_IMAGE_OMA_MEDIA must be an image pinned by digest"],
    [{ BUILDAH_IMAGE: "quay.io/buildah/stable:v1.43.5" }, "BUILDAH_IMAGE must be an image pinned by digest"],
    [{ ENVIRONMENT_IMAGE_REPOSITORY: "registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-environments:latest" }, "without tag or digest"],
    [{ BUILD_NO_PROXY: "" }, "set together"],
    [{ BUILD_PROXY_URL: "http://user:pass@proxy:7890" }, "without credentials"],
    [{ OMA_ENVIRONMENT: "staging" }, "OMA_ENVIRONMENT"],
    [{ BUILD_NAMESPACE: "" }, "requires BUILD_NAMESPACE"],
    [{ SANDBOX_TEMPLATE: undefined }, "requires SANDBOX_TEMPLATE"],
  ])("rejects %j", (change, message) => {
    expect(() => imageBuilderConfigFromEnv({ ...env, ...change })).toThrow(message);
  });
});
