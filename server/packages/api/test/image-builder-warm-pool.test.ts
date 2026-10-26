import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { InMemoryEnvironmentStore } from "@oma-server/store-memory";
import { KubernetesApiError, type KubernetesApi } from "../src/lib/kubernetes.js";
import { KubernetesWarmPool, WarmPoolUpdater, type ImageCacheState, type ImageCaches, type WarmPool } from "../src/image-builder/warm-pool.js";
import { AcsImageCaches, acsRpc, imageCacheName, type AcsRpc } from "../src/image-builder/acs-image-cache.js";
import { ManualClock, settle } from "./fixtures/manual-clock.js";

const OLD = `registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-sandbox@sha256:${"a".repeat(64)}`;
const NEW_DIGEST = "b".repeat(64);
const PLATFORM = { ownerType: "platform" } as const;

class FakePool implements WarmPool {
  readonly name = "oma-test-sandbox";
  readonly set: string[] = [];
  failReads = false;
  constructor(public current = OLD) {}
  async image() {
    if (this.failReads) throw new KubernetesApiError(503, "ServiceUnavailable", "apiserver unavailable");
    return this.current;
  }
  async setImage(image: string) { this.set.push(image); this.current = image; }
}

class FakeCaches implements ImageCaches {
  readonly asked: string[] = [];
  constructor(public state: ImageCacheState = { state: "creating", id: "imc-1" }) {}
  async ensure(image: string) { this.asked.push(image); return this.state; }
}

async function setup(options: { caches?: FakeCaches | null; ready?: boolean } = {}) {
  const store = new InMemoryEnvironmentStore();
  await store.create({ id: "env_video_production", owner: PLATFORM, name: "video-production", description: "", baseImage: "oma-media", initScript: "true\n", env: [], encryptedSecrets: {} });
  const image = `registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-environments@sha256:${NEW_DIGEST}`;
  if (options.ready !== false) await store.buildNow("env_video_production", image);
  const pool = new FakePool();
  const clock = new ManualClock();
  const lines: string[] = [];
  const logger = { info: (line: string) => lines.push(`info ${line}`), warn: (line: string) => lines.push(`warn ${line}`), error: (line: string) => lines.push(`error ${line}`) };
  const caches = options.caches === undefined ? new FakeCaches() : options.caches;
  const updater = new WarmPoolUpdater({ store, environmentId: "env_video_production", pool, caches, clock, logger, recheckMs: 30_000 });
  return { store, image, pool, clock, lines, logger, caches, updater };
}

describe("WarmPoolUpdater: the Warm Pool runs video-production's image (ADR-0024)", () => {
  it("changes nothing until the Environment has an image", async () => {
    const pending = await setup({ ready: false });
    expect(await pending.updater.reconcile()).toBe("no-image");
    expect(pending.pool.set).toEqual([]);
    expect(pending.caches!.asked).toEqual([]);
  });

  it("with ImageCaches, points the pool at the new image only once its cache is ready", async () => {
    const { updater, pool, caches, image, lines } = await setup();
    expect(await updater.reconcile()).toBe("waiting-for-cache");
    expect(await updater.reconcile()).toBe("waiting-for-cache");
    expect(pool.set).toEqual([]);
    expect(caches!.asked).toEqual([image, image]);
    // A wait is logged once per image and state.
    expect(lines.filter((line) => line.includes("state=creating"))).toEqual([`info warm_pool pool=oma-test-sandbox image=${image} cache=imc-1 state=creating; the pool keeps ${OLD}`]);
    caches!.state = { state: "ready", id: "imc-1" };
    expect(await updater.reconcile()).toBe("updated");
    expect(pool.set).toEqual([image]);
    expect(lines.at(-1)).toBe(`info warm_pool_updated pool=oma-test-sandbox image=${image} previous=${OLD} cache=imc-1`);
    expect(await updater.reconcile()).toBe("unchanged");
  });

  it("keeps the old image when the cache failed, and says so", async () => {
    const { updater, pool, caches, lines } = await setup({ caches: new FakeCaches({ state: "failed", id: "imc-2", detail: "Failed" }) });
    expect(await updater.reconcile()).toBe("cache-failed");
    expect(pool.set).toEqual([]);
    expect(caches!.asked).toHaveLength(1);
    expect(lines.at(-1)).toMatch(/^error warm_pool pool=oma-test-sandbox .* cache=imc-2 state=failed detail=Failed; the pool keeps /);
  });

  it("without ImageCaches, points the pool at once and warns that refills pull the whole image", async () => {
    const { updater, pool, image, lines } = await setup({ caches: null });
    expect(await updater.reconcile()).toBe("updated");
    expect(pool.set).toEqual([image]);
    expect(lines.slice(-2)).toEqual([
      `info warm_pool_updated pool=oma-test-sandbox image=${image} previous=${OLD} cache=none`,
      `warn warm_pool_cold_refill pool=oma-test-sandbox: without an ImageCache every refill of the pool pulls ${image} in full`,
    ]);
    expect(await updater.reconcile()).toBe("unchanged");
    expect(pool.set).toEqual([image]);
  });

  it("runs at start, again after video-production's build and on every recheck, surviving API errors", async () => {
    const { updater, pool, caches, clock, store, lines } = await setup();
    pool.failReads = true;
    updater.start();
    await settle();
    expect(lines.at(-1)).toBe("error warm_pool pool=oma-test-sandbox: apiserver unavailable");
    pool.failReads = false;
    await clock.advance(30_000);
    expect(caches!.asked).toHaveLength(1);
    caches!.state = { state: "ready", id: "imc-1" };
    await clock.advance(30_000);
    expect(pool.set).toHaveLength(1);

    // A rebuild succeeds with another image: the builder triggers at once.
    await store.rebuild(PLATFORM, "env_video_production");
    const next = `registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-environments@sha256:${"c".repeat(64)}`;
    await store.buildNow("env_video_production", next);
    updater.trigger();
    await settle();
    expect(pool.set).toEqual([expect.any(String), next]);
    await updater.stop();
  });
});

describe("KubernetesWarmPool", () => {
  function api(set: unknown, calls: Array<{ method: string; path: string; options?: unknown }>): KubernetesApi {
    return {
      async request<T>(method: string, path: string, options?: unknown) {
        calls.push({ method, path, options });
        if (set === null) throw new KubernetesApiError(404, "NotFound", "sandboxsets.agents.kruise.io \"x\" not found");
        return (method === "GET" ? set : {}) as T;
      },
      async stream() { throw new Error("unused"); },
      async close() {},
    };
  }
  const sandboxSet = (containers: unknown[]) => ({ spec: { template: { spec: { containers } } } });

  it("reads and patches the sandbox container's image with a JSON patch that tests its position", async () => {
    const calls: Array<{ method: string; path: string; options?: unknown }> = [];
    const pool = new KubernetesWarmPool(api(sandboxSet([{ name: "sidecar", image: "x@sha256:1" }, { name: "sandbox", image: OLD }]), calls), "sandbox-system", "oma-test-sandbox");
    expect(await pool.image()).toBe(OLD);
    await pool.setImage("new@sha256:2");
    const path = "/apis/agents.kruise.io/v1alpha1/namespaces/sandbox-system/sandboxsets/oma-test-sandbox";
    expect(calls.map((call) => [call.method, call.path])).toEqual([["GET", path], ["GET", path], ["PATCH", path]]);
    expect(calls[2]!.options).toEqual({
      contentType: "application/json-patch+json",
      body: [
        { op: "test", path: "/spec/template/spec/containers/1/name", value: "sandbox" },
        { op: "replace", path: "/spec/template/spec/containers/1/image", value: "new@sha256:2" },
      ],
    });
  });

  it("fails clearly for a missing pool or one without a sandbox container", async () => {
    await expect(new KubernetesWarmPool(api(null, []), "sandbox-system", "gone").image()).rejects.toThrow("Warm Pool sandbox-system/gone does not exist");
    await expect(new KubernetesWarmPool(api(sandboxSet([{ name: "main", image: OLD }]), []), "sandbox-system", "odd").image()).rejects.toThrow("has no sandbox container");
  });
});

describe("AcsImageCaches", () => {
  const config = {
    regionId: "cn-shanghai", securityGroupId: "sg-uf6bikdzvy9di9y8wp89",
    vSwitchIds: ["vsw-uf6kw2gmpn1psc4yqpgqa", "vsw-uf6xsc4rp8k5cpjgcelmu"], environment: "test",
    accessKeyId: "test-id", accessKeySecret: "test-secret-never-sent",
  };
  const image = `registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-environments@sha256:${NEW_DIGEST}`;
  const name = `oma-test-${NEW_DIGEST.slice(0, 16)}`;

  it("backfills an unchanged pool's cache, reuses it after restart and recreates it if removed", async () => {
    const { store, pool, clock, logger } = await setup({ caches: null });
    pool.current = image;
    const calls: string[] = [];
    let listed: Array<{ ImageCacheId: string; ImageCacheName: string; Status: string; Images: string[] }> = [];
    const rpc: AcsRpc = async (action, query) => {
      calls.push(action);
      if (action === "ListImageCaches") return { ImageCaches: listed };
      expect(query.ClientToken).toBe(name);
      listed = [{ ImageCacheId: "imc-backfill", ImageCacheName: name, Status: "Creating", Images: [image] }];
      return { ImageCacheId: "imc-backfill" };
    };
    const updater = () => new WarmPoolUpdater({
      store, environmentId: "env_video_production", pool, clock, logger,
      caches: new AcsImageCaches(config, rpc),
    });
    let running = updater();
    try {
      running.start();
      await settle();
      expect(calls).toEqual(["ListImageCaches", "CreateImageCache"]);
      expect(pool.set).toEqual([]);

      await running.stop();
      running = updater();
      running.start();
      await settle();
      expect(calls).toEqual(["ListImageCaches", "CreateImageCache", "ListImageCaches"]);

      listed[0]!.Status = "Ready";
      await clock.advance(30_000);
      expect(calls).toHaveLength(4);
      expect(calls.at(-1)).toBe("ListImageCaches");
      expect(pool.set).toEqual([]);

      // A cache seen ready is not listed again on every 30 s recheck of the pool…
      listed = [];
      await clock.advance(9 * 60_000);
      expect(calls).toHaveLength(4);
      // …only once the cache recheck interval has passed, which recreates a removed one.
      await clock.advance(60_000);
      expect(calls.slice(-2)).toEqual(["ListImageCaches", "CreateImageCache"]);
      expect(calls.filter((action) => action === "CreateImageCache")).toHaveLength(2);
      expect(pool.set).toEqual([]);
    } finally {
      await running.stop();
    }
  });

  it("creates one cache per image on the cluster's network, then reads its status by name", async () => {
    const calls: Array<[string, Record<string, string>]> = [];
    let listed: unknown[] = [];
    const rpc: AcsRpc = async (action, query) => {
      calls.push([action, query]);
      return action === "ListImageCaches" ? { ImageCaches: listed } : { ImageCacheId: "imc-new" };
    };
    const caches = new AcsImageCaches(config, rpc);
    expect(imageCacheName("test", image)).toBe(name);
    expect(await caches.ensure(image)).toEqual({ state: "creating", id: "imc-new", detail: "created" });
    expect(calls).toEqual([
      ["ListImageCaches", { RegionId: "cn-shanghai", ImageCacheName: name }],
      ["CreateImageCache", {
        RegionId: "cn-shanghai", ImageCacheName: name, "Images.1": image,
        NetworkConfig: JSON.stringify({ SecurityGroupId: config.securityGroupId, VSwitchIds: config.vSwitchIds }),
        ClientToken: name, "Tags.1.Key": "oma.dev/environment", "Tags.1.Value": "test", "Tags.2.Key": "oma.dev/managed-by", "Tags.2.Value": "oma-image-builder",
      }],
    ]);
    for (const [status, state] of [["Preparing", "creating"], ["Creating", "creating"], ["Ready", "ready"], ["Failed", "failed"]] as const) {
      listed = [{ ImageCacheId: "imc-new", ImageCacheName: name, Status: status, Images: [image] }];
      expect(await caches.ensure(image)).toEqual({ state, id: "imc-new", detail: status });
    }
    listed = [{ ImageCacheId: "imc-other", ImageCacheName: name, Status: "Ready", Images: ["other@sha256:1"] }];
    expect(await caches.ensure(image)).toMatchObject({ state: "failed", detail: `${name} caches another image` });
    expect(calls.filter(([action]) => action === "CreateImageCache")).toHaveLength(1);
  });

  it("sends List and Create using the official acc RPC contract without sending the secret", async () => {
    // Alibaba Cloud's acc-20240402/src/client.ts: POST /, RegionId in query,
    // Images and Tags flattened by OpenApiUtil.query, NetworkConfig encoded as JSON.
    // https://github.com/aliyun/alibabacloud-typescript-sdk/blob/master/acc-20240402/src/client.ts
    const requests: Array<{ method: string | undefined; url: string; body: string; headers: Record<string, unknown> }> = [];
    let created = false;
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      requests.push({ method: request.method, url: request.url!, body, headers: request.headers });
      response.writeHead(200, { "content-type": "application/json" });
      if (request.headers["x-acs-action"] === "CreateImageCache") {
        created = true;
        response.end(JSON.stringify({ RequestId: "r", ImageCacheId: "imc-wire" }));
      } else {
        response.end(JSON.stringify({ RequestId: "r", ImageCaches: created
          ? [{ ImageCacheId: "imc-wire", ImageCacheName: name, Status: "Ready", Images: [image] }]
          : [] }));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address() as { port: number };
      const rpc = acsRpc({ ...config, endpoint: `127.0.0.1:${address.port}` }, "HTTP");
      const caches = new AcsImageCaches(config, rpc);
      expect(await caches.ensure(image)).toEqual({ state: "creating", id: "imc-wire", detail: "created" });
      expect(await caches.ensure(image)).toEqual({ state: "ready", id: "imc-wire", detail: "Ready" });
      expect(requests.map((sent) => sent.headers["x-acs-action"])).toEqual(["ListImageCaches", "CreateImageCache", "ListImageCaches"]);
      for (const sent of requests) {
        expect(sent.method).toBe("POST");
        expect(new URL(sent.url, "http://x").pathname).toBe("/");
        expect(sent.body).toBe("");
        expect(sent.headers["x-acs-version"]).toBe("2024-04-02");
        expect(sent.headers.authorization).toMatch(/^ACS3-HMAC-SHA256 Credential=test-id,SignedHeaders=.*,Signature=[0-9a-f]{64}$/);
      }
      const query = (index: number) => Object.fromEntries(new URL(requests[index]!.url, "http://x").searchParams);
      expect(query(0)).toEqual({ RegionId: "cn-shanghai", ImageCacheName: name });
      expect(query(2)).toEqual(query(0));
      const { NetworkConfig: network, ...create } = query(1);
      expect(create).toEqual({
        RegionId: "cn-shanghai", ImageCacheName: name, ClientToken: name, "Images.1": image,
        "Tags.1.Key": "oma.dev/environment", "Tags.1.Value": "test",
        "Tags.2.Key": "oma.dev/managed-by", "Tags.2.Value": "oma-image-builder",
      });
      expect(JSON.parse(network!)).toEqual({ SecurityGroupId: config.securityGroupId, VSwitchIds: config.vSwitchIds });
      expect(JSON.stringify(requests)).not.toContain("test-secret-never-sent");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
