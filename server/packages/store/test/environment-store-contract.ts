import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  EnvironmentNameConflictError,
  environmentDefinitionSha256,
  type EnvironmentOwner,
  type EnvironmentStore,
  type EnvironmentStoreCreateInput,
} from "../src/index.js";

const T1: EnvironmentOwner = { ownerType: "tenant", tenantId: "t1" };
const T2: EnvironmentOwner = { ownerType: "tenant", tenantId: "t2" };
const PLATFORM: EnvironmentOwner = { ownerType: "platform" };

let ids = 0;
function input(owner: EnvironmentOwner, overrides: Partial<EnvironmentStoreCreateInput> = {}): EnvironmentStoreCreateInput {
  return {
    id: `env_contract_${++ids}`,
    owner,
    name: `env-${ids}`,
    description: "",
    baseImage: "oma-base",
    initScript: "pip install requests\n",
    env: [],
    encryptedSecrets: {},
    ...overrides,
  };
}

/** Environment and Environment Build semantics shared by every {@link EnvironmentStore}. */
export function environmentStoreContract(name: string, create: () => Promise<EnvironmentStore>, close?: () => Promise<void>) {
  describe(name, () => {
    let store: EnvironmentStore;
    beforeEach(async () => { store = await create(); });
    afterAll(async () => { await close?.(); });

    it("creates an Environment pending, with its first build snapshotting what to build", async () => {
      const env = await store.create(input(T1, {
        name: "py", description: "Python tools", baseImage: "oma-media", initScript: "apt-get install -y jq\n",
        env: [{ name: "FOO", value: "bar" }, { name: "TOKEN", secretRef: { source: "environment", key: "TOKEN" } }],
        encryptedSecrets: { TOKEN: "ciphertext" },
      }));
      expect(env).toMatchObject({
        ownerType: "tenant", tenantId: "t1", name: "py", description: "Python tools", baseImage: "oma-media",
        initScript: "apt-get install -y jq\n", status: "pending", image: null, manifest: null,
        env: [{ name: "FOO", value: "bar" }, { name: "TOKEN", secretRef: { source: "environment", key: "TOKEN" } }],
        encryptedSecrets: { TOKEN: "ciphertext" },
      });
      expect(env.createdAt).toBeInstanceOf(Date);
      expect(env.updatedAt).toEqual(env.createdAt);
      const builds = await store.listBuilds(env.id);
      expect(builds).toHaveLength(1);
      expect(builds[0]).toMatchObject({
        environmentId: env.id, ownerType: "tenant", tenantId: "t1", status: "pending",
        baseImage: "oma-media", initScript: "apt-get install -y jq\n",
        definitionSha256: environmentDefinitionSha256("oma-media", "apt-get install -y jq\n"),
        baseImageDigest: null, attempts: 0, retries: 0, leaseOwner: null, leaseExpiresAt: null,
        startedAt: null, finishedAt: null, errorCode: null, errorMessage: null, image: null, manifest: null, logKey: null,
      });
      expect(builds[0].id).toMatch(/^envb_/);
      expect(env.lastBuild).toEqual({
        id: builds[0].id, status: "pending", createdAt: builds[0].createdAt,
        startedAt: null, finishedAt: null, errorCode: null, errorMessage: null,
      });
      expect(await store.get("t1", env.id)).toEqual(env);
    });

    it("shows a Tenant its own Environments and every built-in, built-ins first, each by name", async () => {
      const own = await store.create(input(T1, { name: "b-own" }));
      await store.create(input(T1, { name: "a-own" }));
      await store.create(input(T2, { name: "other" }));
      const builtIn = await store.create(input(PLATFORM, { id: "env_video_production", name: "video-production", baseImage: "oma-media" }));
      await store.create(input(PLATFORM, { id: "env_data", name: "data" }));
      expect(builtIn).toMatchObject({ id: "env_video_production", ownerType: "platform", tenantId: null, status: "pending" });
      expect((await store.list("t1")).map((env) => env.name)).toEqual(["data", "video-production", "a-own", "b-own"]);
      expect((await store.list("t2")).map((env) => env.name)).toEqual(["data", "video-production", "other"]);
      expect(await store.get("t2", builtIn.id)).toMatchObject({ id: builtIn.id, ownerType: "platform" });
      expect(await store.get("t2", own.id)).toBeNull();
      expect(await store.get("t1", "env_missing")).toBeNull();
    });

    it("keeps names unique per owner among Environments that are not deleted", async () => {
      const first = await store.create(input(T1, { name: "same" }));
      await expect(store.create(input(T1, { name: "same" }))).rejects.toBeInstanceOf(EnvironmentNameConflictError);
      const other = await store.create(input(T1, { name: "other" }));
      await expect(store.update(T1, other.id, { name: "same" })).rejects.toBeInstanceOf(EnvironmentNameConflictError);
      await store.create(input(T2, { name: "same" }));
      await store.create(input(PLATFORM, { name: "same" }));
      await expect(store.create(input(PLATFORM, { name: "same" }))).rejects.toBeInstanceOf(EnvironmentNameConflictError);
      expect(await store.update(T1, first.id, { name: "same", description: "renamed to itself" })).toMatchObject({ name: "same" });
      expect(await store.delete(T1, first.id)).toBe(true);
      expect(await store.create(input(T1, { name: "same" }))).toMatchObject({ name: "same" });
    });

    it("supersedes the active build and queues a new one when the init script or Base Image changes", async () => {
      const env = await store.create(input(T1));
      const [first] = await store.listBuilds(env.id);
      const scripted = await store.update(T1, env.id, { initScript: "npm install -g pnpm\n" });
      const afterScript = await store.listBuilds(env.id);
      expect(afterScript.map((build) => build.status)).toEqual(["pending", "superseded"]);
      expect(afterScript[1]).toMatchObject({ id: first.id, finishedAt: expect.any(Date) });
      expect(afterScript[0]).toMatchObject({ initScript: "npm install -g pnpm\n", baseImage: "oma-base",
        definitionSha256: environmentDefinitionSha256("oma-base", "npm install -g pnpm\n") });
      expect(scripted).toMatchObject({ status: "pending", initScript: "npm install -g pnpm\n", lastBuild: { id: afterScript[0].id, status: "pending" } });

      const rebased = await store.update(T1, env.id, { baseImage: "oma-media" });
      const afterBase = await store.listBuilds(env.id);
      expect(afterBase.map((build) => build.status)).toEqual(["pending", "superseded", "superseded"]);
      expect(afterBase[0]).toMatchObject({ baseImage: "oma-media", initScript: "npm install -g pnpm\n" });
      expect(rebased?.lastBuild?.id).toBe(afterBase[0].id);
      expect(await store.get("t1", env.id)).toEqual(rebased);
    });

    it("never builds for variables, name, description or an unchanged definition", async () => {
      const env = await store.create(input(T1, { env: [{ name: "A", value: "1" }], encryptedSecrets: { S: "c1" } }));
      const updated = await store.update(T1, env.id, {
        name: "renamed", description: "described", initScript: env.initScript, baseImage: env.baseImage,
        env: [{ name: "B", value: "2" }, { name: "S2", secretRef: { source: "environment", key: "S2" } }],
        encryptedSecrets: { S2: "c2" },
      });
      expect(updated).toMatchObject({
        name: "renamed", description: "described", status: "pending", lastBuild: env.lastBuild,
        env: [{ name: "B", value: "2" }, { name: "S2", secretRef: { source: "environment", key: "S2" } }],
        encryptedSecrets: { S2: "c2" },
      });
      expect(updated!.updatedAt.getTime()).toBeGreaterThanOrEqual(env.updatedAt.getTime());
      expect(await store.listBuilds(env.id)).toHaveLength(1);
    });

    it("changes an Environment only for its owner", async () => {
      const own = await store.create(input(T1));
      const builtIn = await store.create(input(PLATFORM, { id: "env_builtin" }));
      expect(await store.update(T2, own.id, { name: "taken" })).toBeNull();
      expect(await store.update(T1, builtIn.id, { name: "taken" })).toBeNull();
      expect(await store.update(PLATFORM, own.id, { name: "taken" })).toBeNull();
      expect(await store.delete(T1, builtIn.id)).toBe(false);
      expect(await store.delete(T2, own.id)).toBe(false);
      expect(await store.update(T1, "env_missing", { name: "x" })).toBeNull();
      const rebuilt = await store.update(PLATFORM, builtIn.id, { initScript: "echo v2\n" });
      expect(rebuilt).toMatchObject({ ownerType: "platform", tenantId: null, initScript: "echo v2\n", status: "pending" });
      expect((await store.listBuilds(builtIn.id)).map((build) => [build.status, build.ownerType, build.tenantId]))
        .toEqual([["pending", "platform", null], ["superseded", "platform", null]]);
      expect(await store.get("t1", own.id)).toMatchObject({ name: own.name });
    });

    it("reads the Environments a Tenant's Sessions run in: built-ins and its own, deleted ones too, never another Tenant's", async () => {
      const builtIn = await store.create(input(PLATFORM, { name: "video-production" }));
      const own = await store.create(input(T1, { name: "mine" }));
      const deleted = await store.create(input(T1, { name: "gone" }));
      await store.delete(T1, deleted.id);
      const foreign = await store.create(input(T2, { name: "theirs" }));
      const found = await store.listForSessions("t1", [own.id, builtIn.id, deleted.id, foreign.id, own.id, "env_missing"]);
      expect(found.map((env) => env.id).sort()).toEqual([builtIn.id, deleted.id, own.id].sort());
      expect(found.find((env) => env.id === own.id)).toEqual(await store.get("t1", own.id));
      expect(await store.listForSessions("t1", [])).toEqual([]);
      expect(await store.listForSessions("t2", [own.id])).toEqual([]);
    });

    it("reads what a Session's Sandbox needs of its Environment, deleted or not, only where the Tenant sees it", async () => {
      const own = await store.create(input(T1, { name: "vars", env: [{ name: "A", value: "1" }, { name: "T", secretRef: { source: "environment", key: "T" } }],
        encryptedSecrets: { T: "sealed" } }));
      const builtIn = await store.create(input(PLATFORM, { name: "platform-vars", env: [{ name: "P", secretRef: { source: "platform", key: "P" } }] }));
      expect(await store.getForSandbox("t1", own.id)).toEqual({
        id: own.id, tenantId: "t1", image: null, env: own.env, encryptedSecrets: { T: "sealed" },
      });
      expect(await store.getForSandbox("t2", builtIn.id)).toEqual({ id: builtIn.id, tenantId: null, image: null, env: builtIn.env, encryptedSecrets: {} });
      expect(await store.getForSandbox("t2", own.id)).toBeNull();
      expect(await store.getForSandbox("t1", "env_missing")).toBeNull();
      // A variable changed now is what the next read sees.
      await store.update(T1, own.id, { env: [{ name: "A", value: "2" }], encryptedSecrets: {} });
      await store.delete(T1, own.id);
      expect(await store.getForSandbox("t1", own.id)).toMatchObject({ env: [{ name: "A", value: "2" }], encryptedSecrets: {} });
    });

    it("soft-deletes: hidden from every read but a Session's, its builds kept and the active one superseded", async () => {
      const env = await store.create(input(T1));
      expect(await store.delete(T1, env.id)).toBe(true);
      expect(await store.get("t1", env.id)).toBeNull();
      // A Session frozen to it keeps running on it (ADR-0024).
      expect((await store.listForSessions("t1", [env.id])).map((found) => found.id)).toEqual([env.id]);
      expect(await store.list("t1")).toEqual([]);
      expect(await store.update(T1, env.id, { name: "revived" })).toBeNull();
      expect(await store.delete(T1, env.id)).toBe(false);
      expect((await store.listBuilds(env.id)).map((build) => build.status)).toEqual(["superseded"]);
    });
  });
}
