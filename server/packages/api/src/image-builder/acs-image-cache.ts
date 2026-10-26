import { createHash } from "node:crypto";
import OpenApiPackage, { $OpenApiUtil, OpenApiUtil } from "@alicloud/openapi-core";
import type { ImageCacheState, ImageCaches } from "./warm-pool.js";

/**
 * One RPC call of the ACS (`acc`) OpenAPI, version 2024-04-02: the action and
 * its flat query parameters; resolves with the answer's body.
 */
export type AcsRpc = (action: "CreateImageCache" | "ListImageCaches", query: Record<string, string>) => Promise<Record<string, unknown>>;

/** What ACS needs to create ImageCaches: where its puller runs and who may call it. */
export interface AcsImageCacheConfig {
  regionId: string;
  /** The network the cache's puller uses: the cluster pods' security group and vSwitches (#299's bench). */
  securityGroupId: string;
  vSwitchIds: readonly string[];
  /** `OMA_ENVIRONMENT`: part of the cache's name and a tag. */
  environment: string;
  accessKeyId: string;
  accessKeySecret: string;
  /** Default `acc.<region>.aliyuncs.com`. */
  endpoint?: string;
}

/** `oma-<environment>-<first 16 hex of the digest>`: one cache per image and environment. */
export function imageCacheName(environment: string, image: string): string {
  const digest = /@sha256:([0-9a-f]{64})$/.exec(image)?.[1] ?? createHash("sha256").update(image).digest("hex");
  return `oma-${environment}-${digest.slice(0, 16)}`;
}

interface ListedCache {
  ImageCacheId?: string;
  ImageCacheName?: string;
  Status?: string;
  Images?: string[];
}

const READY = new Set(["Ready"]);
const FAILED = new Set(["Failed", "UpdateFailed"]);

/**
 * ACS ImageCaches through the `acc` OpenAPI (CreateImageCache,
 * ListImageCaches), as #299's bench and #301's oma-test pool created them
 * with `aliyun acc create-image-cache`: one image by digest, the cluster
 * pods' network (that of the production cache imc-uf6c2ys46pzt3c3grd74), no
 * registry credential (the account's ACR). Found by name, so a restart or a
 * second call never creates a second cache for the same image.
 * ListImageCaches answers `{ImageCaches: [{ImageCacheId, ImageCacheName,
 * Status, Images}], TotalCount}` (read 2026-10-26).
 */
export class AcsImageCaches implements ImageCaches {
  private readonly rpc: AcsRpc;

  constructor(private readonly config: AcsImageCacheConfig, rpc?: AcsRpc) {
    this.rpc = rpc ?? acsRpc(config);
  }

  async ensure(image: string): Promise<ImageCacheState> {
    const name = imageCacheName(this.config.environment, image);
    const listed = await this.rpc("ListImageCaches", { RegionId: this.config.regionId, ImageCacheName: name });
    const caches = (Array.isArray(listed.ImageCaches) ? listed.ImageCaches : []) as ListedCache[];
    const cache = caches.find((candidate) => candidate.ImageCacheName === name);
    if (cache) {
      if (cache.Images && !cache.Images.includes(image)) return { state: "failed", id: cache.ImageCacheId, detail: `${name} caches another image` };
      const status = cache.Status ?? "";
      return { state: READY.has(status) ? "ready" : FAILED.has(status) ? "failed" : "creating", id: cache.ImageCacheId, detail: status };
    }
    const created = await this.rpc("CreateImageCache", {
      RegionId: this.config.regionId,
      ImageCacheName: name,
      "Images.1": image,
      NetworkConfig: JSON.stringify({ SecurityGroupId: this.config.securityGroupId, VSwitchIds: this.config.vSwitchIds }),
      ClientToken: name,
      "Tags.1.Key": "oma.dev/environment",
      "Tags.1.Value": this.config.environment,
      "Tags.2.Key": "oma.dev/managed-by",
      "Tags.2.Value": "oma-image-builder",
    });
    return { state: "creating", id: typeof created.ImageCacheId === "string" ? created.ImageCacheId : undefined, detail: "created" };
  }
}

/** The OpenAPI client (`@alicloud/openapi-core`, ACS3-HMAC-SHA256) against `acc.<region>.aliyuncs.com`. */
export function acsRpc(config: AcsImageCacheConfig, protocol: "HTTPS" | "HTTP" = "HTTPS"): AcsRpc {
  // The package is CommonJS with a default-exported class; NodeNext surfaces
  // either shape depending on the loader (as in mcp-catalog's RDS AI client).
  const packageWithDefault = OpenApiPackage as unknown as { default?: unknown };
  const Client = (packageWithDefault.default ?? OpenApiPackage) as new (config: $OpenApiUtil.Config) => {
    callApi(params: $OpenApiUtil.Params, request: $OpenApiUtil.OpenApiRequest, runtime: never): Promise<{ body?: unknown }>;
  };
  const client = new Client(new $OpenApiUtil.Config({
    accessKeyId: config.accessKeyId,
    accessKeySecret: config.accessKeySecret,
    regionId: config.regionId,
    endpoint: config.endpoint ?? `acc.${config.regionId}.aliyuncs.com`,
    readTimeout: 30_000,
    connectTimeout: 10_000,
  }));
  return async (action, query) => {
    const params = new $OpenApiUtil.Params({
      action, version: "2024-04-02", protocol, pathname: "/", method: "POST",
      authType: "AK", style: "RPC", reqBodyType: "formData", bodyType: "json",
    });
    const answer = await client.callApi(params, new $OpenApiUtil.OpenApiRequest({ query: OpenApiUtil.query(query) }), {} as never);
    return (answer.body ?? {}) as Record<string, unknown>;
  };
}
