import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type {
  EnvironmentBuildQueue,
  EnvironmentOwner,
  EnvironmentStore,
  EnvironmentStoreCreateInput,
} from "../src/index.js";

const T1: EnvironmentOwner = { ownerType: "tenant", tenantId: "t1" };
const PLATFORM: EnvironmentOwner = { ownerType: "platform" };
const LEASE = 60_000;
const MANIFEST = { schemaVersion: 1, dpkg: [{ name: "jq", version: "1.6" }] };

export interface BuildQueueHarness {
  store: EnvironmentStore & EnvironmentBuildQueue;
  /** Every lease held now expires, by the clock that judges leases. */
  expireLeases(): Promise<void>;
}

let ids = 0;
function input(owner: EnvironmentOwner, overrides: Partial<EnvironmentStoreCreateInput> = {}): EnvironmentStoreCreateInput {
  return {
    id: `env_queue_${++ids}`,
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

/** The image builder's claim, lease, retry and outcome semantics shared by every {@link EnvironmentBuildQueue}. */
export function environmentBuildQueueContract(name: string, create: () => Promise<BuildQueueHarness>, close?: () => Promise<void>) {
  describe(name, () => {
    let store: BuildQueueHarness["store"];
    let expireLeases: BuildQueueHarness["expireLeases"];
    beforeEach(async () => { ({ store, expireLeases } = await create()); });
    afterAll(async () => { await close?.(); });

    it("claims the oldest pending build under a lease, counting the attempt and marking its Environment building", async () => {
      const first = await store.create(input(T1, {
        env: [{ name: "FOO", value: "bar" }, { name: "TOKEN", secretRef: { source: "environment", key: "TOKEN" } }],
        encryptedSecrets: { TOKEN: "ciphertext" },
      }));
      const second = await store.create(input(PLATFORM, { id: "env_builtin_queue", baseImage: "oma-media" }));

      const claimed = await store.claimBuild("builder-a", LEASE);
      expect(claimed).toMatchObject({
        build: { environmentId: first.id, status: "running", attempts: 1, leaseOwner: "builder-a", baseImage: "oma-base", initScript: "pip install requests\n" },
        lease: { buildId: first.lastBuild!.id, owner: "builder-a", attempt: 1 },
        env: [{ name: "FOO", value: "bar" }, { name: "TOKEN", secretRef: { source: "environment", key: "TOKEN" } }],
        reclaimed: false,
      });
      expect(JSON.stringify(claimed)).not.toContain("ciphertext");
      expect(claimed!.build.startedAt).toBeInstanceOf(Date);
      expect(claimed!.build.leaseExpiresAt!.getTime()).toBeGreaterThan(claimed!.build.startedAt!.getTime());
      expect(await store.get("t1", first.id)).toMatchObject({ status: "building", lastBuild: { status: "running", startedAt: claimed!.build.startedAt } });

      const next = await store.claimBuild("builder-a", LEASE);
      expect(next).toMatchObject({ build: { environmentId: second.id, ownerType: "platform", tenantId: null, baseImage: "oma-media" }, reclaimed: false });
      expect(await store.claimBuild("builder-a", LEASE)).toBeNull();
    });

    it("accepts only a positive integer of milliseconds as a lease", async () => {
      await store.create(input(T1));
      for (const leaseMs of [0, -1, 1.5, Number.NaN]) {
        await expect(store.claimBuild("builder-a", leaseMs)).rejects.toThrow(new RangeError("Environment Build lease must be a positive integer of milliseconds"));
      }
      const { lease } = (await store.claimBuild("builder-a", LEASE))!;
      await expect(store.renewBuild(lease, 0)).rejects.toThrow(RangeError);
      await expect(store.retryBuild(lease, 0)).rejects.toThrow(RangeError);
    });

    it("never claims a superseded build, nor one of a deleted Environment", async () => {
      const env = await store.create(input(T1));
      await store.update(T1, env.id, { initScript: "echo v2\n" });
      const gone = await store.create(input(T1));
      await store.delete(T1, gone.id);
      const claimed = await store.claimBuild("builder-a", LEASE);
      expect(claimed!.build).toMatchObject({ environmentId: env.id, initScript: "echo v2\n" });
      expect(await store.claimBuild("builder-a", LEASE)).toBeNull();
    });

    it("renews a held lease; a newer change supersedes the build and an expired lease is lost", async () => {
      const env = await store.create(input(T1));
      const { lease } = (await store.claimBuild("builder-a", LEASE))!;
      expect(await store.renewBuild(lease, LEASE)).toBe("renewed");
      expect(await store.renewBuild({ ...lease, owner: "builder-b" }, LEASE)).toBe("lost");
      expect(await store.renewBuild({ ...lease, attempt: 2 }, LEASE)).toBe("lost");

      await expireLeases();
      expect(await store.renewBuild(lease, LEASE)).toBe("lost");

      const reclaimed = (await store.claimBuild("builder-b", LEASE))!;
      await store.update(T1, env.id, { initScript: "echo v2\n" });
      expect(await store.renewBuild(reclaimed.lease, LEASE)).toBe("superseded");
      expect(await store.succeedBuild(reclaimed.lease, { image: "registry/env@sha256:stale", manifest: MANIFEST })).toBe(false);
      expect(await store.get("t1", env.id)).toMatchObject({ status: "pending", image: null, lastBuild: { status: "pending" } });
    });

    it("reclaims a running build whose lease expired, fencing out the earlier holder", async () => {
      const env = await store.create(input(T1));
      const first = (await store.claimBuild("builder-a", LEASE))!;
      expect(await store.claimBuild("builder-b", LEASE)).toBeNull();
      await expireLeases();

      const second = (await store.claimBuild("builder-b", LEASE))!;
      // A new attempt, but not a retry: only infrastructure failures are.
      expect(second).toMatchObject({ build: { id: first.build.id, attempts: 2, retries: 0, leaseOwner: "builder-b" }, lease: { owner: "builder-b", attempt: 2 }, reclaimed: true });
      expect(second.build.startedAt).toEqual(first.build.startedAt);
      expect(await store.renewBuild(first.lease, LEASE)).toBe("lost");
      expect(await store.retryBuild(first.lease, LEASE)).toBeNull();
      expect(await store.recordBuildProgress(first.lease, { logKey: "stale" })).toBe(false);
      expect(await store.failBuild(first.lease, { code: "stale", message: "stale" })).toBe(false);
      expect(await store.succeedBuild(first.lease, { image: "registry/env@sha256:stale", manifest: MANIFEST })).toBe(false);
      expect(await store.get("t1", env.id)).toMatchObject({ status: "building", image: null });

      // A reclaim by the same owner is a new attempt too.
      await expireLeases();
      const third = (await store.claimBuild("builder-b", LEASE))!;
      expect(third.lease).toEqual({ buildId: first.build.id, owner: "builder-b", attempt: 3 });
      expect(await store.renewBuild(second.lease, LEASE)).toBe("lost");
    });

    it("releases a lease so the build is reclaimed at once", async () => {
      await store.create(input(T1));
      const first = (await store.claimBuild("builder-a", LEASE))!;
      expect(await store.releaseBuild({ ...first.lease, owner: "other" })).toBe(false);
      expect(await store.releaseBuild(first.lease)).toBe(true);
      expect(await store.claimBuild("builder-b", LEASE)).toMatchObject({ reclaimed: true, build: { attempts: 2, retries: 0 }, lease: { attempt: 2 } });
    });

    it("retries under the same owner as a new attempt, fencing the previous one", async () => {
      const env = await store.create(input(T1));
      const { lease } = (await store.claimBuild("builder-a", LEASE))!;
      const retried = await store.retryBuild(lease, LEASE);
      expect(retried).toEqual({ ...lease, attempt: 2 });
      expect(await store.renewBuild(lease, LEASE)).toBe("lost");
      expect(await store.renewBuild(retried!, LEASE)).toBe("renewed");
      expect(await store.getBuild(env.id, lease.buildId)).toMatchObject({ attempts: 2, retries: 1 });
      await store.update(T1, env.id, { initScript: "echo v2\n" });
      expect(await store.retryBuild(retried!, LEASE)).toBeNull();
    });

    it("keeps the retries across a release and a reclaim, which count as attempts only", async () => {
      await store.create(input(T1));
      const { lease } = (await store.claimBuild("builder-a", LEASE))!;
      const retried = (await store.retryBuild(lease, LEASE))!;
      expect(await store.releaseBuild(retried)).toBe(true);
      const resumed = (await store.claimBuild("builder-b", LEASE))!;
      expect(resumed).toMatchObject({ reclaimed: true, build: { attempts: 3, retries: 1 }, lease: { owner: "builder-b", attempt: 3 } });
      await expireLeases();
      const again = (await store.claimBuild("builder-c", LEASE))!;
      expect(again.build).toMatchObject({ attempts: 4, retries: 1 });
      expect(await store.retryBuild(again.lease, LEASE)).toEqual({ ...again.lease, attempt: 5 });
      expect(await store.getBuild(again.build.environmentId, again.build.id)).toMatchObject({ attempts: 5, retries: 2 });
    });

    it("records the Base Image digest and the log key under the lease", async () => {
      const env = await store.create(input(T1));
      const { lease } = (await store.claimBuild("builder-a", LEASE))!;
      expect(await store.recordBuildProgress(lease, { baseImageDigest: "sha256:base" })).toBe(true);
      expect(await store.recordBuildProgress(lease, { logKey: "__oma/environment-builds/t1/b.log" })).toBe(true);
      expect(await store.getBuild(env.id, lease.buildId)).toMatchObject({ baseImageDigest: "sha256:base", logKey: "__oma/environment-builds/t1/b.log" });
    });

    it("a successful build replaces the image; a failed rebuild keeps it and records the error", async () => {
      const env = await store.create(input(T1));
      const { lease } = (await store.claimBuild("builder-a", LEASE))!;
      expect(await store.succeedBuild(lease, { image: "registry/env@sha256:one", manifest: MANIFEST })).toBe(true);
      expect(await store.succeedBuild(lease, { image: "registry/env@sha256:again", manifest: MANIFEST })).toBe(false);
      const ready = await store.get("t1", env.id);
      expect(ready).toMatchObject({ status: "ready", image: "registry/env@sha256:one", manifest: MANIFEST, lastBuild: { id: lease.buildId, status: "succeeded", errorCode: null } });
      expect(ready!.lastBuild!.finishedAt).toBeInstanceOf(Date);
      expect(await store.getBuild(env.id, lease.buildId)).toMatchObject({ status: "succeeded", image: "registry/env@sha256:one", manifest: MANIFEST });

      const rebuilt = await store.rebuild(T1, env.id);
      expect(rebuilt).toMatchObject({ status: "pending", image: "registry/env@sha256:one", manifest: MANIFEST, lastBuild: { status: "pending" } });
      expect(rebuilt!.lastBuild!.id).not.toBe(lease.buildId);
      const again = (await store.claimBuild("builder-a", LEASE))!;
      expect(again.build).toMatchObject({ id: rebuilt!.lastBuild!.id, initScript: env.initScript, baseImage: env.baseImage, definitionSha256: (await store.getBuild(env.id, lease.buildId))!.definitionSha256 });
      expect(await store.get("t1", env.id)).toMatchObject({ status: "building", image: "registry/env@sha256:one" });
      expect(await store.failBuild(again.lease, { code: "environment_build_script_failed", message: "init.sh line 3: false (exit status 1)" })).toBe(true);
      expect(await store.get("t1", env.id)).toMatchObject({
        status: "failed", image: "registry/env@sha256:one", manifest: MANIFEST,
        lastBuild: { id: again.lease.buildId, status: "failed", errorCode: "environment_build_script_failed", errorMessage: "init.sh line 3: false (exit status 1)" },
      });
      expect(await store.failBuild(again.lease, { code: "x", message: "x" })).toBe(false);
    });

    it("a superseded build's outcome changes nothing: the Environment follows its latest build", async () => {
      const env = await store.create(input(T1));
      const old = (await store.claimBuild("builder-a", LEASE))!;
      await store.update(T1, env.id, { initScript: "echo v2\n" });
      expect(await store.failBuild(old.lease, { code: "x", message: "x" })).toBe(false);
      expect(await store.succeedBuild(old.lease, { image: "registry/env@sha256:old", manifest: MANIFEST })).toBe(false);
      expect((await store.getBuild(env.id, old.lease.buildId))!.status).toBe("superseded");
      const latest = (await store.claimBuild("builder-a", LEASE))!;
      expect(latest.build.initScript).toBe("echo v2\n");
      expect(await store.succeedBuild(latest.lease, { image: "registry/env@sha256:v2", manifest: MANIFEST })).toBe(true);
      expect(await store.get("t1", env.id)).toMatchObject({ status: "ready", image: "registry/env@sha256:v2", initScript: "echo v2\n" });
    });

    it("reads a built-in by its id, never a Tenant's Environment or a deleted one", async () => {
      const builtIn = await store.create(input(PLATFORM, { id: "env_builtin_read", name: "builtin-read" }));
      const own = await store.create(input(T1));
      expect(await store.getBuiltIn(builtIn.id)).toMatchObject({ id: builtIn.id, ownerType: "platform", tenantId: null, status: "pending" });
      expect(await store.getBuiltIn(own.id)).toBeNull();
      expect(await store.getBuiltIn("env_missing")).toBeNull();
      await store.delete(PLATFORM, builtIn.id);
      expect(await store.getBuiltIn(builtIn.id)).toBeNull();
    });

    it("lists the Environments whose latest build finished on another digest of their Base Image", async () => {
      const finish = async (envId: string, digest: string | null, outcome: "succeeded" | "failed") => {
        for (;;) {
          const claimed = (await store.claimBuild("builder-a", LEASE))!;
          if (digest) await store.recordBuildProgress(claimed.lease, { baseImageDigest: digest });
          const done = outcome === "succeeded"
            ? await store.succeedBuild(claimed.lease, { image: `registry/env@sha256:${envId}`, manifest: MANIFEST })
            : await store.failBuild(claimed.lease, { code: "x", message: "x" });
          expect(done).toBe(true);
          if (claimed.build.environmentId === envId) return;
        }
      };
      const old = await store.create(input(T1, { id: "env_a_old" }));
      await finish(old.id, "sha256:old", "succeeded");
      const current = await store.create(input(T1, { id: "env_b_current" }));
      await finish(current.id, "sha256:new", "succeeded");
      const failedOld = await store.create(input(PLATFORM, { id: "env_c_failed_old", name: "failed-old" }));
      await finish(failedOld.id, "sha256:old", "failed");
      const failedNew = await store.create(input(T1, { id: "env_d_failed_new" }));
      await finish(failedNew.id, "sha256:new", "failed");
      const unrecorded = await store.create(input(T1, { id: "env_e_unrecorded" }));
      await finish(unrecorded.id, null, "failed");
      const media = await store.create(input(T1, { id: "env_f_media", baseImage: "oma-media" }));
      await finish(media.id, "sha256:media-old", "succeeded");
      const deleted = await store.create(input(T1, { id: "env_g_deleted" }));
      await finish(deleted.id, "sha256:old", "succeeded");
      await store.delete(T1, deleted.id);
      // A rebuild queued for the old digest is left to run on the configured one.
      const queued = await store.create(input(T1, { id: "env_h_queued" }));
      await finish(queued.id, "sha256:old", "succeeded");
      await store.rebuild(T1, queued.id);

      expect(await store.listBuiltOnOtherBaseImage("oma-base", "sha256:new")).toEqual([
        { id: old.id, owner: T1 },
        { id: failedOld.id, owner: PLATFORM },
        { id: unrecorded.id, owner: T1 },
      ]);
      expect(await store.listBuiltOnOtherBaseImage("oma-media", "sha256:media-old")).toEqual([]);
      expect(await store.listBuiltOnOtherBaseImage("oma-media", "sha256:media-new")).toEqual([{ id: media.id, owner: T1 }]);
    });

    it("rebuilds only for the owner, superseding the active build", async () => {
      const env = await store.create(input(T1));
      const builtIn = await store.create(input(PLATFORM, { id: "env_builtin_rebuild" }));
      const [first] = await store.listBuilds(env.id);
      expect(await store.rebuild({ ownerType: "tenant", tenantId: "t2" }, env.id)).toBeNull();
      expect(await store.rebuild(T1, builtIn.id)).toBeNull();
      expect(await store.rebuild(PLATFORM, builtIn.id)).toMatchObject({ status: "pending" });
      const rebuilt = await store.rebuild(T1, env.id);
      expect((await store.listBuilds(env.id)).map((build) => build.status)).toEqual(["pending", "superseded"]);
      expect(rebuilt!.lastBuild!.id).not.toBe(first.id);
      expect(await store.getBuild(env.id, first.id)).toMatchObject({ id: first.id, status: "superseded" });
      expect(await store.getBuild(builtIn.id, first.id)).toBeNull();
      expect(await store.getBuild(env.id, "envb_missing")).toBeNull();
      await store.delete(T1, env.id);
      expect(await store.rebuild(T1, env.id)).toBeNull();
    });
  });
}
