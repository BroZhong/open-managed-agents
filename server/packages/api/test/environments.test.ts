import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStores, InMemoryEnvironmentBuildLogStore } from "@oma-server/store-memory";
import { environmentBuildLogKey } from "@oma-server/store";
import { createApp } from "../src/app.js";
import { EnvironmentService } from "../src/lib/environments.js";
import { SecretBox } from "../src/lib/secret-box.js";

const KEY = "ab".repeat(32);
const SECRET = "sk-environment-secret-value";

async function setup(options: { key?: string; inUse?: (tenantId: string, id: string) => Promise<boolean> } = {}) {
  const stores = createMemoryStores();
  const secrets = new SecretBox("key" in options ? options.key : KEY, () => new Error("unavailable"));
  const logs = new InMemoryEnvironmentBuildLogStore();
  const service = new EnvironmentService(stores.environmentStore, "key" in options ? options.key : KEY, { inUse: options.inUse, logs });
  const app = createApp({ apiKeyStore: stores.apiKeyStore, environmentService: service });
  const keys = {
    t1: (await stores.apiKeyStore.create("t1", "t1")).rawKey,
    t2: (await stores.apiKeyStore.create("t2", "t2")).rawKey,
  };
  const call = async (tenant: keyof typeof keys, method: string, path: string, body?: unknown) => {
    const response = await app.request(path, {
      method,
      headers: { "x-api-key": keys[tenant], ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, text, body: text ? JSON.parse(text) : undefined };
  };
  const builtIn = await stores.environmentStore.create({
    id: "env_video_production", owner: { ownerType: "platform" }, name: "video-production", description: "Video tools",
    baseImage: "oma-media", initScript: "apt-get install -y libgl1\n",
    env: [{ name: "HTTP_PROXY", value: "http://proxy:7890" }, { name: "GEMINI_API_KEY", secretRef: { source: "platform", key: "GEMINI_API_KEY" } }],
    encryptedSecrets: {},
  });
  return { stores, service, app, call, builtIn, secrets, logs };
}

const create = { name: "py", baseImage: "oma-base", initScript: "pip install requests\n" };

describe("Environment routes (ADR-0024)", () => {
  beforeEach(() => { vi.unstubAllEnvs(); vi.stubEnv("AUTH_DISABLED", "false"); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("creates an Environment pending with a queued build, and reads it back without secret values", async () => {
    const { call, stores } = await setup();
    const created = await call("t1", "POST", "/v1/environments", {
      ...create, description: "Python",
      env: [{ name: "FOO", value: "bar" }, { name: "OPENAI_API_KEY", secretRef: { source: "environment", key: "OPENAI_API_KEY" }, value: SECRET }],
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      id: expect.stringMatching(/^env_/), ownerType: "tenant", name: "py", description: "Python", baseImage: "oma-base",
      initScript: "pip install requests\n", status: "pending", image: null, manifest: null,
      env: [{ name: "FOO", value: "bar" }, { name: "OPENAI_API_KEY", secretRef: { source: "environment", key: "OPENAI_API_KEY" } }],
      lastBuild: { id: expect.stringMatching(/^envb_/), status: "pending", startedAt: null, finishedAt: null, errorCode: null, errorMessage: null },
    });
    expect(created.body).not.toHaveProperty("encryptedSecrets");
    expect(created.body).not.toHaveProperty("tenantId");
    const id = created.body.id;
    const builds = await stores.environmentStore.listBuilds(id);
    expect(builds.map((build) => [build.status, build.baseImage, build.initScript])).toEqual([["pending", "oma-base", "pip install requests\n"]]);
    const stored = await stores.environmentStore.get("t1", id);
    expect(stored!.encryptedSecrets.OPENAI_API_KEY).toBeTruthy();
    expect(JSON.stringify(stored)).not.toContain(SECRET);

    const read = await call("t1", "GET", `/v1/environments/${id}`);
    expect(read.status).toBe(200);
    expect(read.body).toEqual(created.body);
    const listed = await call("t1", "GET", "/v1/environments");
    expect(listed.body.data.map((env: { id: string }) => env.id)).toEqual(["env_video_production", id]);
    expect(listed.body.data[1]).not.toHaveProperty("initScript");
    expect(listed.body.data[1]).not.toHaveProperty("env");
    for (const text of [created.text, read.text, listed.text]) expect(text).not.toContain(SECRET);
    expect((await call("t2", "GET", `/v1/environments/${id}`)).body).toMatchObject({ code: "environment_not_found" });
    expect((await call("t2", "GET", "/v1/environments")).body.data.map((env: { id: string }) => env.id)).toEqual(["env_video_production"]);
  });

  it("builds again only when the init script or Base Image changes, superseding the unfinished build", async () => {
    const { call, stores } = await setup();
    const { body: env } = await call("t1", "POST", "/v1/environments", { ...create, env: [{ name: "A", value: "1" }] });
    const builds = () => stores.environmentStore.listBuilds(env.id);
    for (const change of [{ name: "renamed" }, { description: "described" }, { env: [{ name: "A", value: "2" }] }, { initScript: create.initScript, baseImage: "oma-base" }]) {
      const updated = await call("t1", "POST", `/v1/environments/${env.id}`, change);
      expect(updated.status).toBe(200);
      expect(updated.body.lastBuild.id).toBe(env.lastBuild.id);
    }
    expect(await builds()).toHaveLength(1);
    const scripted = await call("t1", "POST", `/v1/environments/${env.id}`, { initScript: "npm i -g pnpm\n" });
    expect(scripted.body).toMatchObject({ status: "pending", initScript: "npm i -g pnpm\n", name: "renamed", env: [{ name: "A", value: "2" }] });
    expect(scripted.body.lastBuild.id).not.toBe(env.lastBuild.id);
    const rebased = await call("t1", "POST", `/v1/environments/${env.id}`, { baseImage: "oma-media" });
    expect((await builds()).map((build) => build.status)).toEqual(["pending", "superseded", "superseded"]);
    expect((await builds())[0].id).toBe(rebased.body.lastBuild.id);
  });

  it("keeps Tenant secrets write-only: kept when sent without a value, replaced with one, dropped when unreferenced", async () => {
    const { call, stores, secrets } = await setup();
    const ref = { source: "environment", key: "TOKEN" };
    const { body: env } = await call("t1", "POST", "/v1/environments", { ...create, env: [{ name: "TOKEN", secretRef: ref, value: SECRET }] });
    const sealed = async () => (await stores.environmentStore.get("t1", env.id))!.encryptedSecrets;
    const first = (await sealed()).TOKEN;
    const open = (value: string) => secrets.open(value, `environment:t1:${env.id}:TOKEN`);
    expect(open(first)).toBe(SECRET);

    await call("t1", "POST", `/v1/environments/${env.id}`, { env: [{ name: "TOKEN", secretRef: ref }, { name: "B", value: "b" }] });
    expect((await sealed()).TOKEN).toBe(first);
    await call("t1", "POST", `/v1/environments/${env.id}`, { env: [{ name: "TOKEN", secretRef: ref, value: "rotated" }] });
    expect(open((await sealed()).TOKEN)).toBe("rotated");
    await call("t1", "POST", `/v1/environments/${env.id}`, { env: [] });
    expect(await sealed()).toEqual({});
    const missing = await call("t1", "POST", `/v1/environments/${env.id}`, { env: [{ name: "TOKEN", secretRef: ref }] });
    expect(missing).toMatchObject({ status: 400, body: { code: "environment_secret_missing" } });
  });

  it("keeps the secret stored when an edit is written, not one a concurrent rotation replaced", async () => {
    const { call, stores, secrets } = await setup();
    const ref = { source: "environment", key: "TOKEN" };
    const { body: env } = await call("t1", "POST", "/v1/environments", { ...create, env: [{ name: "TOKEN", secretRef: ref, value: SECRET }] });
    const open = async () => secrets.open((await stores.environmentStore.get("t1", env.id))!.encryptedSecrets.TOKEN!, `environment:t1:${env.id}:TOKEN`);
    // Hold an edit that sends the secret without a value until a rotation is written.
    const update = stores.environmentStore.update.bind(stores.environmentStore);
    let reached!: () => void;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { reached = resolve; });
    const resumed = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(stores.environmentStore, "update").mockImplementationOnce(async (...args) => { reached(); await resumed; return update(...args); });
    const edit = call("t1", "POST", `/v1/environments/${env.id}`, { env: [{ name: "TOKEN", secretRef: ref }, { name: "MODE", value: "edited" }] });
    await held;
    expect((await call("t1", "POST", `/v1/environments/${env.id}`, { env: [{ name: "TOKEN", secretRef: ref, value: "rotated" }] })).status).toBe(200);
    expect(await open()).toBe("rotated");
    release();
    expect((await edit).body.env).toEqual([{ name: "TOKEN", secretRef: ref }, { name: "MODE", value: "edited" }]);
    expect(await open()).toBe("rotated");
  });

  it("rejects empty plain values, reserved and invalid names, oversize variables and scripts", async () => {
    const { call } = await setup();
    const reject = async (body: unknown, code: string) => {
      const response = await call("t1", "POST", "/v1/environments", body);
      expect(response.status, JSON.stringify(body).slice(0, 200)).toBe(400);
      expect(response.body.code).toBe(code);
      expect(response.body.error).toEqual(expect.any(String));
    };
    await reject({ ...create, env: [{ name: "FOO", value: "" }] }, "environment_env_empty_value");
    await reject({ ...create, env: [{ name: "S", secretRef: { source: "environment", key: "S" }, value: "" }] }, "environment_env_empty_value");
    for (const name of ["PATH", "HOME", "WORKSPACE_DIR", "OMA_TENANT_ID", "E2B_SANDBOX", "BASH_ENV"]) {
      await reject({ ...create, env: [{ name, value: "x" }] }, "environment_env_reserved");
    }
    await reject({ ...create, env: [{ name: "1BAD", value: "x" }] }, "environment_env_invalid");
    await reject({ ...create, env: [{ name: "A", value: "1" }, { name: "A", value: "2" }] }, "environment_env_invalid");
    await reject({ ...create, env: [{ name: "A", secretRef: { source: "environment", key: "bad key" }, value: "1" }] }, "environment_env_invalid");
    await reject({ ...create, env: [{ name: "A", secretRef: { source: "vault", key: "A" } }] }, "validation_error");
    const half = "x".repeat(16 * 1024);
    await reject({ ...create, env: [{ name: "A", value: half }, { name: "B", secretRef: { source: "environment", key: "B" }, value: `${half}y` }] }, "environment_env_too_large");
    await reject({ ...create, initScript: "#".repeat(256 * 1024 + 1) }, "environment_init_script_too_large");
    await reject({ ...create, initScript: "é".repeat(128 * 1024 + 1) }, "environment_init_script_too_large");
    await reject({ baseImage: "oma-base" }, "validation_error");
    await reject({ name: "x", baseImage: "ubuntu" }, "validation_error");
    await reject({ ...create, name: "   " }, "validation_error");
    await reject({ ...create, extra: true }, "validation_error");
    const ok = await call("t1", "POST", "/v1/environments", { ...create, initScript: "#".repeat(256 * 1024), env: [{ name: "A", value: "x".repeat(32 * 1024) }] });
    expect(ok.status).toBe(201);
  });

  it("keeps names unique per Tenant", async () => {
    const { call } = await setup();
    const { body: first } = await call("t1", "POST", "/v1/environments", create);
    expect((await call("t1", "POST", "/v1/environments", create)).body).toMatchObject({ code: "environment_name_conflict" });
    expect((await call("t2", "POST", "/v1/environments", create)).status).toBe(201);
    const { body: other } = await call("t1", "POST", "/v1/environments", { ...create, name: "other" });
    expect(await call("t1", "POST", `/v1/environments/${other.id}`, { name: "py" })).toMatchObject({ status: 409, body: { code: "environment_name_conflict" } });
    expect((await call("t1", "POST", "/v1/environments", { ...create, name: "video-production" })).status).toBe(201);
    expect((await call("t1", "DELETE", `/v1/environments/${first.id}`)).status).toBe(200);
    expect((await call("t1", "POST", "/v1/environments", create)).status).toBe(201);
  });

  it("serves Built-in Environments read-only to every Tenant", async () => {
    const { call, builtIn } = await setup();
    const read = await call("t2", "GET", `/v1/environments/${builtIn.id}`);
    expect(read.body).toMatchObject({
      ownerType: "platform", name: "video-production",
      env: [{ name: "HTTP_PROXY", value: "http://proxy:7890" }, { name: "GEMINI_API_KEY", secretRef: { source: "platform", key: "GEMINI_API_KEY" } }],
    });
    expect(await call("t1", "POST", `/v1/environments/${builtIn.id}`, { name: "mine" })).toMatchObject({ status: 403, body: { code: "environment_read_only" } });
    expect(await call("t1", "DELETE", `/v1/environments/${builtIn.id}`)).toMatchObject({ status: 403, body: { code: "environment_read_only" } });
  });

  it("copies a built-in with its platform secret references, which no other Environment can name", async () => {
    const { call, stores, builtIn } = await setup();
    const forged = await call("t1", "POST", "/v1/environments", { ...create, env: [{ name: "GEMINI_API_KEY", secretRef: { source: "platform", key: "GEMINI_API_KEY" } }] });
    expect(forged).toMatchObject({ status: 400, body: { code: "environment_secret_ref_forbidden" } });

    const copy = await call("t1", "POST", "/v1/environments", { from: builtIn.id });
    expect(copy.status).toBe(201);
    expect(copy.body).toMatchObject({
      ownerType: "tenant", name: "video-production-copy", description: "Video tools", baseImage: "oma-media",
      initScript: "apt-get install -y libgl1\n", status: "pending", env: builtIn.env,
    });
    expect(copy.body.id).not.toBe(builtIn.id);
    expect(await stores.environmentStore.listBuilds(copy.body.id)).toHaveLength(1);
    expect((await call("t1", "POST", "/v1/environments", { from: builtIn.id })).body.name).toBe("video-production-copy-2");

    // A carried reference survives edits; a new one, or one moved to another key, does not.
    const platform = { name: "GEMINI_API_KEY", secretRef: { source: "platform", key: "GEMINI_API_KEY" } };
    expect((await call("t1", "POST", `/v1/environments/${copy.body.id}`, { env: [platform, { name: "MINE", value: "1" }] })).status).toBe(200);
    for (const env of [[{ ...platform, secretRef: { source: "platform", key: "VFS_TOKEN" } }], [{ ...platform, name: "RENAMED" }]]) {
      expect((await call("t1", "POST", `/v1/environments/${copy.body.id}`, { env })).body.code).toBe("environment_secret_ref_forbidden");
    }
    const withValue = await call("t1", "POST", `/v1/environments/${copy.body.id}`, { env: [{ ...platform, value: "guess" }] });
    expect(withValue.body.code).toBe("environment_env_invalid");
    const overridden = await call("t1", "POST", "/v1/environments", { from: builtIn.id, name: "video-mine", baseImage: "oma-base", env: [platform] });
    expect(overridden.body).toMatchObject({ name: "video-mine", baseImage: "oma-base", initScript: "apt-get install -y libgl1\n", env: [platform] });
  });

  it("copies a Tenant Environment's secrets server-side, sealed for the copy", async () => {
    const { call, stores, secrets } = await setup();
    const { body: source } = await call("t1", "POST", "/v1/environments", {
      ...create, env: [{ name: "TOKEN", secretRef: { source: "environment", key: "TOKEN" }, value: SECRET }],
    });
    const copy = await call("t1", "POST", "/v1/environments", { from: source.id, name: "py-2" });
    expect(copy.body).toMatchObject({ name: "py-2", env: source.env });
    expect(copy.text).not.toContain(SECRET);
    const sealed = (await stores.environmentStore.get("t1", copy.body.id))!.encryptedSecrets.TOKEN;
    expect(secrets.open(sealed, `environment:t1:${copy.body.id}:TOKEN`)).toBe(SECRET);
    expect(() => secrets.open(sealed, `environment:t1:${source.id}:TOKEN`)).toThrow();
    expect((await call("t2", "POST", "/v1/environments", { from: source.id })).body).toMatchObject({ code: "environment_not_found" });
  });

  it("soft-deletes, with a seam for Agents that use the Environment", async () => {
    let used = false;
    const { call, stores } = await setup({ inUse: async () => used });
    const { body: env } = await call("t1", "POST", "/v1/environments", create);
    expect(await call("t2", "DELETE", `/v1/environments/${env.id}`)).toMatchObject({ status: 404 });
    used = true;
    expect(await call("t1", "DELETE", `/v1/environments/${env.id}`)).toMatchObject({ status: 409, body: { code: "environment_in_use" } });
    used = false;
    expect(await call("t1", "DELETE", `/v1/environments/${env.id}`)).toMatchObject({ status: 200, body: { type: "environment_deleted", id: env.id } });
    expect((await call("t1", "GET", `/v1/environments/${env.id}`)).status).toBe(404);
    expect((await call("t1", "POST", `/v1/environments/${env.id}`, { name: "x" })).status).toBe(404);
    expect((await call("t1", "DELETE", `/v1/environments/${env.id}`)).status).toBe(404);
    expect((await stores.environmentStore.listBuilds(env.id)).map((build) => build.status)).toEqual(["superseded"]);
  });

  it("rebuilds a Tenant's Environment, superseding its unfinished build; built-ins are the platform's", async () => {
    const { call, stores, builtIn } = await setup();
    const { body: env } = await call("t1", "POST", "/v1/environments", create);
    const rebuilt = await call("t1", "POST", `/v1/environments/${env.id}/build`);
    expect(rebuilt.status).toBe(202);
    expect(rebuilt.body).toMatchObject({ id: env.id, status: "pending", initScript: create.initScript, lastBuild: { status: "pending" } });
    expect(rebuilt.body.lastBuild.id).not.toBe(env.lastBuild.id);
    const builds = await stores.environmentStore.listBuilds(env.id);
    expect(builds.map((build) => [build.status, build.initScript])).toEqual([["pending", create.initScript], ["superseded", create.initScript]]);
    expect(await call("t1", "POST", `/v1/environments/${builtIn.id}/build`)).toMatchObject({ status: 403, body: { code: "environment_read_only" } });
    expect(await call("t2", "POST", `/v1/environments/${env.id}/build`)).toMatchObject({ status: 404, body: { code: "environment_not_found" } });
  });

  it("serves a build's log by byte offset with its status, for 2 s polling", async () => {
    const { call, stores, logs, builtIn } = await setup();
    const { body: env } = await call("t1", "POST", "/v1/environments", create);
    const first = env.lastBuild.id;
    const empty = await call("t1", "GET", `/v1/environments/${env.id}/log`);
    expect(empty).toMatchObject({ status: 200, body: { build: { id: first, status: "pending" }, finished: false, text: "", offset: 0, nextOffset: 0, truncated: false } });

    // The built-in's build is older and claimed first.
    await stores.environmentStore.claimBuild("builder-1", 60_000);
    const claimed = (await stores.environmentStore.claimBuild("builder-1", 60_000))!;
    expect(claimed.build.id).toBe(first);
    await logs.write(environmentBuildLogKey("t1", first), { text: "==> Pulling\n构建\n", start: 0 });
    const page = await call("t1", "GET", `/v1/environments/${env.id}/log`);
    expect(page.body).toMatchObject({ build: { id: first, status: "running" }, finished: false, text: "==> Pulling\n构建\n", offset: 0, nextOffset: 19 });
    const tail = await call("t1", "GET", `/v1/environments/${env.id}/log?offset=12`);
    expect(tail.body).toMatchObject({ text: "构建\n", offset: 12, nextOffset: 19 });
    expect((await call("t1", "GET", `/v1/environments/${env.id}/log?offset=99`)).body).toMatchObject({ text: "", offset: 19, nextOffset: 19 });

    // The kept tail dropped its head: reading from before it says so.
    await logs.write(environmentBuildLogKey("t1", first), { text: "line 9\n", start: 2_000_000 });
    await stores.environmentStore.failBuild(claimed.lease, { code: "environment_build_script_failed", message: "The init script failed at line 2" });
    const truncated = await call("t1", "GET", `/v1/environments/${env.id}/log?offset=19`);
    expect(truncated.body).toMatchObject({
      build: { id: first, status: "failed", errorCode: "environment_build_script_failed", errorMessage: "The init script failed at line 2" },
      finished: true, text: "line 9\n", offset: 2_000_000, nextOffset: 2_000_007, truncated: true,
    });

    const { body: rebuilt } = await call("t1", "POST", `/v1/environments/${env.id}/build`);
    expect((await call("t1", "GET", `/v1/environments/${env.id}/log`)).body.build.id).toBe(rebuilt.lastBuild.id);
    expect((await call("t1", "GET", `/v1/environments/${env.id}/log?build_id=${first}`)).body).toMatchObject({ build: { id: first }, text: "line 9\n" });
    expect(await call("t1", "GET", `/v1/environments/${env.id}/log?build_id=envb_missing`)).toMatchObject({ status: 404, body: { code: "environment_build_not_found" } });
    expect(await call("t1", "GET", `/v1/environments/${env.id}/log?build_id=${builtIn.lastBuild!.id}`)).toMatchObject({ status: 404 });
    expect(await call("t1", "GET", `/v1/environments/${env.id}/log?offset=-1`)).toMatchObject({ status: 400, body: { code: "validation_error" } });
    expect(await call("t2", "GET", `/v1/environments/${env.id}/log`)).toMatchObject({ status: 404, body: { code: "environment_not_found" } });

    await logs.write(environmentBuildLogKey(null, builtIn.lastBuild!.id), { text: "built-in\n", start: 0 });
    expect((await call("t2", "GET", `/v1/environments/${builtIn.id}/log`)).body).toMatchObject({ build: { id: builtIn.lastBuild!.id }, text: "built-in\n" });
  });

  it("needs the encryption key only to write or copy secrets", async () => {
    const { call } = await setup({ key: undefined });
    const { body: plain } = await call("t1", "POST", "/v1/environments", { ...create, env: [{ name: "A", value: "1" }] });
    expect(plain.status).toBe("pending");
    const secret = await call("t1", "POST", "/v1/environments", { ...create, name: "s", env: [{ name: "S", secretRef: { source: "environment", key: "S" }, value: "v" }] });
    expect(secret).toMatchObject({ status: 503, body: { code: "environment_secrets_unavailable" } });
  });
});
