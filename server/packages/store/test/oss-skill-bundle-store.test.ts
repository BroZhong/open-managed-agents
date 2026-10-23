import { describe, expect, it } from "vitest";
import type { OSSObjectClient } from "../src/oss/artifact-store.js";
import { OSSSkillBundleStore, packSkillBundle } from "../src/index.js";
import { fakeOSS, ossTestOptions } from "./oss-harness.js";
import { createOSSHTTPHarness } from "./oss-http-harness.js";
import { skillBundleStoreContract } from "./skill-bundle-store-contract.js";

const fixtures: Array<{ close(): Promise<void> }> = [];
skillBundleStoreContract("OSSSkillBundleStore over the official SDK wire protocol", async () => {
  const fixture = await createOSSHTTPHarness();
  fixtures.push(fixture);
  return {
    store: new OSSSkillBundleStore({ ...ossTestOptions, endpoint: fixture.endpoint }),
    // Preserve the signed resource and query; route transport to the OSS fixture.
    async download(url) {
      const signed = new URL(url);
      const response = await fetch(`${fixture.endpoint}${signed.pathname}${signed.search}`, { headers: { host: signed.host } });
      if (!response.ok) throw new Error(`Install download failed: ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}, async () => { for (const fixture of fixtures.splice(0)) await fixture.close(); });

const text = (value: string) => new TextEncoder().encode(value);

function countingOSS() {
  const fake = fakeOSS();
  const calls = { get: 0, put: 0 };
  const client: OSSObjectClient = {
    ...fake.client,
    async get(name) { calls.get += 1; return fake.client.get(name); },
    async put(name, body, options) { calls.put += 1; return fake.client.put(name, body, options); },
  };
  return { client, objects: fake.objects, calls };
}

describe("OSSSkillBundleStore", () => {
  it("writes each bundle once under the tenant's system prefix as a zip object", async () => {
    const oss = countingOSS();
    const store = new OSSSkillBundleStore({ ...ossTestOptions, client: oss.client });
    const bundle = await packSkillBundle([{ path: "SKILL.md", body: text("hello") }]);
    await store.put("tenant_A-1", bundle);
    expect([...oss.objects.keys()]).toEqual([`__oma/skills/tenant_A-1/${bundle.sha256}.zip`]);
    expect(oss.objects.get(`__oma/skills/tenant_A-1/${bundle.sha256}.zip`)).toMatchObject({ contentType: "application/zip" });
    expect(Buffer.from(oss.objects.get(`__oma/skills/tenant_A-1/${bundle.sha256}.zip`)!.body).equals(Buffer.from(bundle.bytes))).toBe(true);
  });

  it("signs install URLs with V4 against the region's internal endpoint only", async () => {
    const store = new OSSSkillBundleStore(ossTestOptions);
    const sha = "a".repeat(64);
    const url = new URL(await store.createInstallUrl("t1", sha, 300));
    expect(url.origin).toBe("https://agentry.oss-cn-shanghai-internal.aliyuncs.com");
    expect(url.pathname).toBe(`/__oma/skills/t1/${sha}.zip`);
    expect(url.searchParams.get("x-oss-signature-version")).toBe("OSS4-HMAC-SHA256");
    expect(url.searchParams.get("x-oss-expires")).toBe("300");
    expect(url.searchParams.get("x-oss-credential")).toMatch(/^test-access-id\/\d{8}\/cn-shanghai\/oss\/aliyun_v4_request$/);
    expect(url.href).not.toContain(ossTestOptions.accessKeySecret);
    const explicit = new OSSSkillBundleStore({ ...ossTestOptions, internalEndpoint: "https://oss-cn-shanghai-internal.aliyuncs.com" });
    expect(new URL(await explicit.createInstallUrl("t1", sha, 60)).host).toBe("agentry.oss-cn-shanghai-internal.aliyuncs.com");
  });

  it.each([
    "https://oss-cn-shanghai.aliyuncs.com",
    "https://oss-cn-beijing-internal.aliyuncs.com",
    "http://oss-cn-shanghai-internal.aliyuncs.com",
    "https://oss-cn-shanghai-internal.aliyuncs.com/prefix",
    "https://files.example.com",
    "not a url",
  ])("rejects install endpoint %s", (internalEndpoint) => {
    expect(() => new OSSSkillBundleStore({ ...ossTestOptions, internalEndpoint }))
      .toThrow("Skill Bundle install URLs must use the region's internal OSS endpoint");
  });

  it("rejects an invalid region", () => {
    expect(() => new OSSSkillBundleStore({ ...ossTestOptions, region: "oss-cn-shanghai-internal" })).toThrow("Invalid OSS region");
    expect(() => new OSSSkillBundleStore({ ...ossTestOptions, region: "cn-shanghai" })).toThrow("Invalid OSS region");
  });

  it("serves repeated reads of an immutable bundle from a bounded in-process cache", async () => {
    const oss = countingOSS();
    const store = new OSSSkillBundleStore({ ...ossTestOptions, client: oss.client });
    const bundle = await packSkillBundle([{ path: "SKILL.md", body: text("hello") }, { path: "a.txt", body: text("a") }]);
    // A miss is never cached: the bundle becomes readable once stored.
    expect(await store.get("t1", bundle.sha256)).toBeNull();
    await store.put("t1", bundle);
    const reader = new OSSSkillBundleStore({ ...ossTestOptions, client: oss.client });
    oss.calls.get = 0;
    await Promise.all([reader.listFiles("t1", bundle.sha256), reader.readFile("t1", bundle.sha256, "a.txt")]);
    await reader.readAll("t1", bundle.sha256);
    await reader.get("t1", bundle.sha256);
    expect(oss.calls.get).toBe(1);
    // The writer's own put seeds its cache.
    await store.readAll("t1", bundle.sha256);
    expect(oss.calls.get).toBe(1);
  });

  it("does not cache when the cache budget is zero or a bundle exceeds it", async () => {
    const oss = countingOSS();
    const bundle = await packSkillBundle([{ path: "SKILL.md", body: text("hello") }]);
    await new OSSSkillBundleStore({ ...ossTestOptions, client: oss.client }).put("t1", bundle);
    oss.calls.get = 0;
    const uncached = new OSSSkillBundleStore({ ...ossTestOptions, client: oss.client, cacheBytes: 0 });
    await uncached.listFiles("t1", bundle.sha256);
    await uncached.listFiles("t1", bundle.sha256);
    expect(oss.calls.get).toBe(2);
    const tiny = new OSSSkillBundleStore({ ...ossTestOptions, client: oss.client, cacheBytes: bundle.bytes.byteLength - 1 });
    await tiny.listFiles("t1", bundle.sha256);
    await tiny.listFiles("t1", bundle.sha256);
    expect(oss.calls.get).toBe(4);
  });

  it("propagates storage failures other than a missing object", async () => {
    const failing: OSSObjectClient = {
      ...fakeOSS().client,
      async get() { throw Object.assign(new Error("Bucket absent"), { status: 404, code: "NoSuchBucket" }); },
    };
    const store = new OSSSkillBundleStore({ ...ossTestOptions, client: failing });
    await expect(store.get("t1", "a".repeat(64))).rejects.toMatchObject({ code: "NoSuchBucket" });
  });
});
