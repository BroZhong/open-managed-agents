import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryEnvironmentStore } from "@oma-server/store-memory";
import type { EnvironmentOwner } from "@oma-server/store";
import {
  loadBuiltInEnvironments,
  parseBuiltInEnvironment,
  rebuildOnNewBaseImages,
  syncBuiltInEnvironments,
  type BuiltInEnvironmentDefinition,
} from "../src/image-builder/builtin-environments.js";

const REPO_DEFINITIONS = new URL("../../../../sandbox/environments/", import.meta.url).pathname;
const PLATFORM: EnvironmentOwner = { ownerType: "platform" };
const T1: EnvironmentOwner = { ownerType: "tenant", tenantId: "t1" };
const quiet = { info() {}, error() {} };
const ref = (c: string) => `registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-sandbox@sha256:${c.repeat(64)}`;

const definition = (overrides: Partial<BuiltInEnvironmentDefinition> = {}): BuiltInEnvironmentDefinition => ({
  id: "env_video_production", name: "video-production", description: "Video tools", baseImage: "oma-media",
  env: [{ name: "HTTP_PROXY", value: "http://sing-box:7890" }, { name: "VFS_TOKEN", secretRef: { source: "platform", key: "VFS_TOKEN" } }],
  initScript: "#!/usr/bin/env bash\nset -euo pipefail\napt-get install -y libgl1\n",
  ...overrides,
});

let dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))); dirs = []; });

describe("Built-in Environments from the repository (ADR-0024)", () => {
  it("loads sandbox/environments as shipped: video-production on oma-media with platform secrets", async () => {
    const [video, ...others] = await loadBuiltInEnvironments(REPO_DEFINITIONS);
    expect(others).toEqual([]);
    expect(video).toMatchObject({ id: "env_video_production", name: "video-production", baseImage: "oma-media" });
    expect(video!.initScript).toMatch(/^#!\/usr\/bin\/env bash\n/);
    expect(video!.env.filter((variable) => "secretRef" in variable).every((variable) => "secretRef" in variable && variable.secretRef.source === "platform")).toBe(true);
    expect(video!.env.find((variable) => variable.name === "HTTPS_PROXY")).toEqual({ name: "HTTPS_PROXY", value: "http://sing-box.oma-infra.svc.cluster.local:7890" });
  });

  it("rejects a definition the API would not accept", async () => {
    const json = (value: unknown) => JSON.stringify({ id: "env_x", name: "x", description: "", baseImage: "oma-base", env: [], ...value as object });
    expect(parseBuiltInEnvironment("x", json({}), "true\n")).toMatchObject({ id: "env_x", env: [] });
    for (const [value, message] of [
      [{ id: "video" }, "id must match"],
      [{ name: "y" }, "directory's name"],
      [{ baseImage: "ubuntu" }, "baseImage must be one of"],
      [{ extra: 1 }, "unexpected fields"],
      [{ env: [{ name: "PATH", value: "/x" }] }, "PATH is reserved"],
      [{ env: [{ name: "A", value: "" }] }, "non-empty value"],
      [{ env: [{ name: "A", value: "1" }, { name: "A", value: "2" }] }, "declared twice"],
      [{ env: [{ name: "T", secretRef: { source: "environment", key: "T" } }] }, "platform secretRef"],
    ] as const) {
      expect(() => parseBuiltInEnvironment("x", json(value), "true\n"), message).toThrow(message);
    }
    expect(() => parseBuiltInEnvironment("x", "{", "")).toThrow("not JSON");

    const dir = await mkdtemp(join(tmpdir(), "oma-builtins-"));
    dirs.push(dir);
    for (const name of ["a", "b"]) {
      await mkdir(join(dir, name));
      await writeFile(join(dir, name, "environment.json"), JSON.stringify({ id: "env_same", name, description: "", baseImage: "oma-base", env: [] }));
      await writeFile(join(dir, name, "init.sh"), "true\n");
    }
    await expect(loadBuiltInEnvironments(dir)).rejects.toThrow("id env_same is used twice");
  });

  it("writes each built-in once by its id: restarting creates and builds nothing new", async () => {
    const store = new InMemoryEnvironmentStore();
    expect(await syncBuiltInEnvironments(store, [definition()], quiet)).toEqual({ env_video_production: "created" });
    const created = (await store.getBuiltIn("env_video_production"))!;
    expect(created).toMatchObject({ ownerType: "platform", tenantId: null, name: "video-production", status: "pending", encryptedSecrets: {} });
    for (let restart = 0; restart < 2; restart++) {
      expect(await syncBuiltInEnvironments(store, [definition()], quiet)).toEqual({ env_video_production: "unchanged" });
    }
    expect(await store.listBuilds(created.id)).toHaveLength(1);
    expect((await store.getBuiltIn(created.id))!.updatedAt).toEqual(created.updatedAt);
    // Every Tenant sees it, read-only through the API.
    expect((await store.list("any-tenant")).map((env) => env.id)).toEqual(["env_video_production"]);
  });

  it("rebuilds for a new init script or Base Image, never for variables, name or description", async () => {
    const store = new InMemoryEnvironmentStore();
    await syncBuiltInEnvironments(store, [definition()], quiet);
    const builds = async () => (await store.listBuilds("env_video_production")).map((build) => build.status);

    const env = [{ name: "HTTP_PROXY", value: "http://other:3128" }, { name: "VFS_TOKEN", secretRef: { source: "platform" as const, key: "VFS_TOKEN" } }];
    expect(await syncBuiltInEnvironments(store, [definition({ env, description: "Video and more" })], quiet)).toEqual({ env_video_production: "updated" });
    expect(await builds()).toEqual(["pending"]);
    expect(await store.getBuiltIn("env_video_production")).toMatchObject({ description: "Video and more", env });

    expect(await syncBuiltInEnvironments(store, [definition({ env, description: "Video and more", initScript: "#!/usr/bin/env bash\necho v2\n" })], quiet))
      .toEqual({ env_video_production: "rebuilt" });
    expect(await builds()).toEqual(["pending", "superseded"]);
    expect(await syncBuiltInEnvironments(store, [definition({ env, description: "Video and more", initScript: "#!/usr/bin/env bash\necho v2\n", baseImage: "oma-base" })], quiet))
      .toEqual({ env_video_production: "rebuilt" });
    const [latest] = await store.listBuilds("env_video_production");
    expect(latest).toMatchObject({ status: "pending", baseImage: "oma-base", initScript: "#!/usr/bin/env bash\necho v2\n" });
  });

  it("compares variables whatever order their fields come back in", async () => {
    const store = new InMemoryEnvironmentStore();
    await syncBuiltInEnvironments(store, [definition()], quiet);
    const reordered = definition({ env: [{ value: "http://sing-box:7890", name: "HTTP_PROXY" } as never, { secretRef: { key: "VFS_TOKEN", source: "platform" }, name: "VFS_TOKEN" } as never] });
    expect(await syncBuiltInEnvironments(store, [reordered], quiet)).toEqual({ env_video_production: "unchanged" });
  });

  it("queues a built-in whose latest build failed once more at startup: an operator restart retries it", async () => {
    const store = new InMemoryEnvironmentStore();
    await syncBuiltInEnvironments(store, [definition()], quiet);
    const claimed = (await store.claimBuild("builder", 60_000))!;
    await store.failBuild(claimed.lease, { code: "environment_build_infrastructure_failed", message: "registry unreachable" });
    const lines: string[] = [];
    expect(await syncBuiltInEnvironments(store, [definition()], { info: (line: string) => lines.push(line), error() {} }))
      .toEqual({ env_video_production: "retried" });
    expect(lines).toEqual(["builtin_environment id=env_video_production change=retried"]);
    expect((await store.listBuilds("env_video_production")).map((build) => build.status)).toEqual(["pending", "failed"]);
    // Queued once: restarting again leaves the pending build alone.
    expect(await syncBuiltInEnvironments(store, [definition()], quiet)).toEqual({ env_video_production: "unchanged" });
    expect(await store.listBuilds("env_video_production")).toHaveLength(2);
  });

  it("queues one build for a failed built-in, whatever else changed", async () => {
    const store = new InMemoryEnvironmentStore();
    await syncBuiltInEnvironments(store, [definition()], quiet);
    const fail = async () => {
      const claimed = (await store.claimBuild("builder", 60_000))!;
      await store.failBuild(claimed.lease, { code: "environment_build_script_failed", message: "line 3" });
    };
    const statuses = async () => (await store.listBuilds("env_video_production")).map((build) => build.status);

    await fail();
    expect(await syncBuiltInEnvironments(store, [definition({ description: "Video and more" })], quiet)).toEqual({ env_video_production: "retried" });
    expect(await store.getBuiltIn("env_video_production")).toMatchObject({ description: "Video and more", status: "pending" });
    expect(await statuses()).toEqual(["pending", "failed"]);

    await fail();
    expect(await syncBuiltInEnvironments(store, [definition({ description: "Video and more", initScript: "#!/usr/bin/env bash\necho fixed\n" })], quiet))
      .toEqual({ env_video_production: "rebuilt" });
    expect(await statuses()).toEqual(["pending", "failed", "failed"]);
  });

  it("writes the other built-ins when one fails", async () => {
    const store = new InMemoryEnvironmentStore();
    // A built-in of that name already exists under another id.
    await store.create({ ...definition({ id: "env_old_video" }), owner: PLATFORM, encryptedSecrets: {} });
    const errors: string[] = [];
    const changes = await syncBuiltInEnvironments(store, [definition(), definition({ id: "env_data", name: "data", baseImage: "oma-base" })], { info() {}, error: (line: string) => errors.push(line) });
    expect(changes).toEqual({ env_video_production: "failed", env_data: "created" });
    expect(errors[0]).toMatch(/^builtin_environment env_video_production: .*video-production/);
  });
});

describe("Base Image upgrades rebuild every Environment on them (ADR-0024)", () => {
  /** Run every pending build to its outcome as the builder would, on `digests`. */
  async function build(store: InMemoryEnvironmentStore, digests: Record<string, string>, fail: string[] = []) {
    for (;;) {
      const claimed = await store.claimBuild("builder", 60_000);
      if (!claimed) return;
      await store.recordBuildProgress(claimed.lease, { baseImageDigest: digests[claimed.build.baseImage]!.split("@")[1] });
      if (fail.includes(claimed.build.environmentId)) await store.failBuild(claimed.lease, { code: "environment_build_script_failed", message: "x" });
      else await store.succeedBuild(claimed.lease, { image: `registry/env@sha256:${claimed.build.id}`, manifest: {} });
    }
  }
  const create = (store: InMemoryEnvironmentStore, id: string, owner: EnvironmentOwner, baseImage: "oma-base" | "oma-media") =>
    store.create({ id, owner, name: id, description: "", baseImage, initScript: "true\n", env: [], encryptedSecrets: {} });

  it("queues a rebuild for exactly the Environments on the changed Base Image, once", async () => {
    const store = new InMemoryEnvironmentStore();
    const old = { "oma-base": ref("1"), "oma-media": ref("2") };
    await syncBuiltInEnvironments(store, [definition()], quiet);
    await create(store, "env_t1_base", T1, "oma-base");
    await create(store, "env_t1_media", T1, "oma-media");
    await create(store, "env_t1_broken", T1, "oma-media");
    await create(store, "env_t1_gone", T1, "oma-media");
    await build(store, old, ["env_t1_broken"]);
    await store.delete(T1, "env_t1_gone");
    expect(await rebuildOnNewBaseImages(store, old, quiet)).toEqual({ queued: [], failed: [] });

    const upgraded = { "oma-base": ref("1"), "oma-media": ref("3") };
    const result = await rebuildOnNewBaseImages(store, upgraded, quiet);
    expect(result).toEqual({ queued: ["env_t1_broken", "env_t1_media", "env_video_production"], failed: [] });
    for (const id of result.queued) expect((await store.listBuilds(id))[0]).toMatchObject({ status: "pending", baseImage: "oma-media" });
    expect((await store.listBuilds("env_t1_base"))[0]!.status).toBe("succeeded");
    expect((await store.listBuilds("env_t1_gone"))).toHaveLength(1);
    // The serving images stay until each rebuild succeeds.
    expect(await store.getBuiltIn("env_video_production")).toMatchObject({ status: "pending", image: expect.stringMatching(/^registry\/env@sha256:/) });

    // Restarting before the rebuilds ran, or after they ran (one failing), queues nothing again.
    expect(await rebuildOnNewBaseImages(store, upgraded, quiet)).toEqual({ queued: [], failed: [] });
    await build(store, upgraded, ["env_t1_media"]);
    expect(await rebuildOnNewBaseImages(store, upgraded, quiet)).toEqual({ queued: [], failed: [] });
    expect((await store.get("t1", "env_t1_media"))!.status).toBe("failed");
    expect((await store.get("t1", "env_t1_broken"))!.status).toBe("ready");
    expect((await store.getBuiltIn("env_video_production"))!.status).toBe("ready");
  });

  it("queues every other rebuild when one cannot be queued", async () => {
    const store = new InMemoryEnvironmentStore();
    await create(store, "env_a", T1, "oma-base");
    await create(store, "env_b", T1, "oma-base");
    await create(store, "env_c", T1, "oma-base");
    await build(store, { "oma-base": ref("1"), "oma-media": ref("2") });
    const rebuild = store.rebuild.bind(store);
    store.rebuild = async (owner, id) => { if (id === "env_b") throw new Error("connection reset"); return rebuild(owner, id); };
    const errors: string[] = [];
    expect(await rebuildOnNewBaseImages(store, { "oma-base": ref("9"), "oma-media": ref("2") }, { info() {}, error: (line: string) => errors.push(line) }))
      .toEqual({ queued: ["env_a", "env_c"], failed: ["env_b"] });
    expect(errors).toEqual(["base_image_rebuild environment=env_b: connection reset"]);
  });
});
