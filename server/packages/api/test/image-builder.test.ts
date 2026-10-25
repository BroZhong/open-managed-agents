import { afterEach, describe, expect, it } from "vitest";
import { InMemoryEnvironmentBuildLogStore, InMemoryEnvironmentStore } from "@oma-server/store-memory";
import { environmentBuildLogKey, type EnvironmentBuildQueue, type EnvironmentStoreCreateInput } from "@oma-server/store";
import { BUILD_ERRORS, BUILD_TIMING, EnvironmentBuilder, type BuildOutcome } from "../src/image-builder/builder.js";
import type { BuildAttemptRef, BuildJob, BuildLogSink, BuildRunResult, BuildRunner, ImageVerifier, VerificationResult } from "../src/image-builder/ports.js";
import { ManualClock, settle } from "./fixtures/manual-clock.js";

const REPO = "registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-environments";
const BASE = `registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-sandbox@sha256:${"b".repeat(64)}`;
const MEDIA = `registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-sandbox@sha256:${"m".repeat(0)}${"c".repeat(64)}`;
const digest = (n: number) => `sha256:${String(n).padStart(64, "0")}`;
const MANIFEST = { schemaVersion: 1, dpkg: [{ name: "jq", version: "1.6" }] };
const TENANT = { ownerType: "tenant", tenantId: "t1" } as const;

type Step = (job: BuildJob, io: { log: BuildLogSink; signal: AbortSignal }) => Promise<BuildRunResult>;

/** A build pod that runs `steps` in order, one per attempt; the last repeats. */
class FakeRunner implements BuildRunner {
  readonly jobs: BuildJob[] = [];
  readonly deleted: string[] = [];
  readonly cleanups: string[] = [];
  readonly sweeps: Array<(ref: BuildAttemptRef) => Promise<boolean>> = [];
  /** Pods the cluster lists for the sweep. */
  pods: BuildAttemptRef[] = [];
  readonly swept: BuildAttemptRef[] = [];
  constructor(public steps: Step[] = [pushed(1)]) {}
  async run(job: BuildJob, io: { log: BuildLogSink; signal: AbortSignal }): Promise<BuildRunResult> {
    this.jobs.push(job);
    const step = this.steps[Math.min(this.jobs.length - 1, this.steps.length - 1)]!;
    try {
      return await step(job, io);
    } finally {
      this.deleted.push(`${job.buildId}/${job.attempt}`);
    }
  }
  async cleanup(buildId: string) { this.cleanups.push(buildId); }
  async sweep(keep: (ref: BuildAttemptRef) => Promise<boolean>) {
    this.sweeps.push(keep);
    let deleted = 0;
    for (const pod of this.pods) if (!await keep(pod)) { this.swept.push(pod); deleted++; }
    this.pods = this.pods.filter((pod) => !this.swept.includes(pod));
    return deleted;
  }
}

function pushed(n: number, lines = ["==> Pulling the Base Image\n", "Building\n"]): Step {
  return async (_job, io) => {
    for (const line of lines) io.log(line);
    return { outcome: "pushed", digest: digest(n) };
  };
}
const failing = (result: BuildRunResult): Step => async () => result;
/** A pod that runs until the test ends it or the builder aborts it. */
function blocking(): Step & { finish: (result: BuildRunResult) => void; started: Promise<void> } {
  let finish!: (result: BuildRunResult) => void;
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  const step = ((_job, io) => new Promise<BuildRunResult>((resolve, reject) => {
    finish = resolve;
    io.log("==> Building\n");
    started();
    io.signal.addEventListener("abort", () => reject(io.signal.reason), { once: true });
  })) as Step & { finish: (result: BuildRunResult) => void; started: Promise<void> };
  step.finish = (result) => finish(result);
  step.started = startedPromise;
  return step;
}

class FakeVerifier implements ImageVerifier {
  readonly images: string[] = [];
  readonly refs: BuildAttemptRef[] = [];
  sweeps = 0;
  sandboxes: BuildAttemptRef[] = [];
  readonly swept: BuildAttemptRef[] = [];
  constructor(public results: VerificationResult[] = [{ ok: true, manifest: MANIFEST }]) {}
  async verify(image: string, io: { ref: BuildAttemptRef; log: BuildLogSink }): Promise<VerificationResult> {
    this.images.push(image);
    this.refs.push(io.ref);
    io.log("Claimed a Sandbox; envd, bash and /home/user are fine.");
    return this.results[Math.min(this.images.length - 1, this.results.length - 1)]!;
  }
  async sweep(keep: (ref: BuildAttemptRef) => Promise<boolean>) {
    this.sweeps++;
    for (const sandbox of this.sandboxes) if (!await keep(sandbox)) this.swept.push(sandbox);
    return this.swept.length;
  }
}

let builders: EnvironmentBuilder[] = [];
afterEach(async () => {
  await Promise.all(builders.map((builder) => builder.stop()));
  builders = [];
});

function setup(options: { runner?: FakeRunner; verifier?: FakeVerifier; queue?: (store: InMemoryEnvironmentStore) => EnvironmentBuildQueue } = {}) {
  const clock = new ManualClock();
  const store = new InMemoryEnvironmentStore({ now: clock.date });
  const logs = new InMemoryEnvironmentBuildLogStore();
  const runner = options.runner ?? new FakeRunner();
  const verifier = options.verifier ?? new FakeVerifier();
  let nonces = 0;
  const ended = new Map<EnvironmentBuilder, BuildOutcome[]>();
  const builder = (owner = "builder-a") => {
    const outcomes: BuildOutcome[] = [];
    const created = new EnvironmentBuilder({
      queue: options.queue?.(store) ?? store, runner, verifier, logs, clock,
      config: {
        owner, deployment: "test", repository: REPO, baseImages: { "oma-base": BASE, "oma-media": MEDIA },
        platformDefaults: { PIP_INDEX_URL: "https://mirrors.aliyun.com/pypi/simple/" },
        proxy: { url: "http://sing-box.oma-infra.svc.cluster.local:7890", noProxy: "localhost,.aliyuncs.com" },
      },
      logger: {
        info(line: string) { const outcome = / outcome=(\w+)$/.exec(line)?.[1]; if (outcome) outcomes.push(outcome as BuildOutcome); },
        warn() {}, error() {},
      },
      nonce: () => `nonce${++nonces}`,
    });
    ended.set(created, outcomes);
    builders.push(created);
    return created;
  };
  let ids = 0;
  const create = (overrides: Partial<EnvironmentStoreCreateInput> = {}) => store.create({
    id: `env_${++ids}`, owner: TENANT, name: `env-${ids}`, description: "", baseImage: "oma-base",
    initScript: "apt-get install -y jq\n", env: [], encryptedSecrets: {}, ...overrides,
  });
  /** Claim and run until every build this builder started has an outcome; the outcomes since the last call. */
  const drain = async (target: EnvironmentBuilder) => {
    const outcomes: BuildOutcome[] = [];
    while (await target.poll()) outcomes.push(...await waitIdle(target));
    return outcomes;
  };
  const waitIdle = async (target: EnvironmentBuilder) => {
    while (target.runningCount) await settle();
    return ended.get(target)!.splice(0);
  };
  const logOf = async (tenantId: string | null, buildId: string) => (await logs.read(environmentBuildLogKey(tenantId, buildId)))?.text ?? "";
  return { clock, store, logs, runner, verifier, builder, create, drain, waitIdle, logOf };
}

describe("EnvironmentBuilder (ADR-0024 Building)", () => {
  it("builds a pending Environment, verifies the pushed image and only then makes it ready", async () => {
    const { builder, create, store, runner, verifier, logOf, drain } = setup();
    const env = await create({
      initScript: "pip install requests\n",
      env: [{ name: "FOO", value: "bar" }, { name: "API_TOKEN", secretRef: { source: "environment", key: "API_TOKEN" } }],
      encryptedSecrets: { API_TOKEN: "ciphertext-never-in-a-build" },
    });
    const outcomes = await drain(builder());
    expect(outcomes).toEqual(["succeeded"]);
    const [job] = runner.jobs;
    const buildId = env.lastBuild!.id;
    expect(job).toMatchObject({ buildId, environmentId: env.id, attempt: 1, baseImage: BASE, target: `${REPO}:test-${env.id}-${buildId}`, nonce: "nonce1" });
    expect(job!.context.Dockerfile).toContain(`FROM ${BASE}\n`);
    expect(job!.context["init.sh"]).toBe("pip install requests\n");
    expect(job!.context["build.env"]).toContain("FOO='bar'");
    expect(job!.context["build.env"]).toContain("HTTPS_PROXY='http://sing-box.oma-infra.svc.cluster.local:7890'");
    expect(JSON.stringify(job!.context)).not.toMatch(/API_TOKEN|ciphertext/);
    expect(verifier.images).toEqual([`${REPO}@${digest(1)}`]);

    expect(await store.get("t1", env.id)).toMatchObject({
      status: "ready", image: `${REPO}@${digest(1)}`, manifest: MANIFEST, lastBuild: { id: buildId, status: "succeeded", errorCode: null },
    });
    expect(await store.getBuild(env.id, buildId)).toMatchObject({
      attempts: 1, baseImageDigest: `sha256:${"b".repeat(64)}`, image: `${REPO}@${digest(1)}`, manifest: MANIFEST,
      logKey: `__oma/environment-builds/t1/${buildId}.log`,
    });
    const log = await logOf("t1", buildId);
    expect(log).toContain("Attempt 1: building oma-base");
    expect(log).toContain("==> Pulling the Base Image\nBuilding\n");
    expect(log).toContain(`Pushed ${REPO}@${digest(1)}. Verifying it`);
    expect(log).toContain("envd, bash and /home/user are fine.");
    expect(log).toMatch(/Ready: .* now serves this Environment\.\n$/);
    expect(runner.deleted).toEqual([`${buildId}/1`]);
  });

  it("shows the Environment building while its build runs, the log readable as it grows", async () => {
    const step = blocking();
    const { builder, create, store, clock, logOf } = setup({ runner: new FakeRunner([step]) });
    const env = await create();
    const running = builder();
    expect(await running.poll()).toBe(1);
    await step.started;
    expect(await store.get("t1", env.id)).toMatchObject({ status: "building", lastBuild: { status: "running" } });
    expect(await logOf("t1", env.lastBuild!.id)).toBe("");
    await clock.advance(BUILD_TIMING.logFlushMs);
    expect(await logOf("t1", env.lastBuild!.id)).toContain("==> Building\n");
    step.finish({ outcome: "pushed", digest: digest(7) });
    await settle();
    expect(await store.get("t1", env.id)).toMatchObject({ status: "ready", image: `${REPO}@${digest(7)}` });
  });

  it("fails a script failure at once, keeps the serving image and names the failing line; a fixed script builds", async () => {
    const runner = new FakeRunner([pushed(1)]);
    const { builder, create, store, logOf, drain } = setup({ runner });
    const env = await create();
    const worker = builder();
    await drain(worker);

    await store.update(TENANT, env.id, { initScript: "set -x\nfalse\n" });
    runner.steps = [failing({ outcome: "script_failed", message: "The init script failed at line 2: false (exit status 1)" })];
    expect(await drain(worker)).toEqual(["failed"]);
    const failed = await store.get("t1", env.id);
    expect(failed).toMatchObject({
      status: "failed", image: `${REPO}@${digest(1)}`, manifest: MANIFEST,
      lastBuild: { status: "failed", errorCode: BUILD_ERRORS.script, errorMessage: "The init script failed at line 2: false (exit status 1)" },
    });
    expect(runner.jobs).toHaveLength(2);
    expect(await logOf("t1", failed!.lastBuild!.id)).toContain(`Build failed (${BUILD_ERRORS.script}): The init script failed at line 2`);

    await store.update(TENANT, env.id, { initScript: "true\n" });
    runner.steps = [pushed(3)];
    expect(await drain(worker)).toEqual(["succeeded"]);
    expect(await store.get("t1", env.id)).toMatchObject({ status: "ready", image: `${REPO}@${digest(3)}`, initScript: "true\n" });
    expect(runner.jobs.at(-1)!.context["init.sh"]).toBe("true\n");
  });

  it("retries infrastructure failures twice, as new attempts, then fails", async () => {
    const runner = new FakeRunner([failing({ outcome: "infrastructure_failed", stage: "pull", message: "buildah pull failed" })]);
    const { builder, create, store, logOf, drain } = setup({ runner });
    const env = await create();
    expect(await drain(builder())).toEqual(["failed"]);
    expect(runner.jobs.map((job) => job.attempt)).toEqual([1, 2, 3]);
    expect(new Set(runner.jobs.map((job) => job.nonce)).size).toBe(3);
    expect(await store.get("t1", env.id)).toMatchObject({
      status: "failed", image: null,
      lastBuild: { errorCode: BUILD_ERRORS.infrastructure, errorMessage: "Infrastructure failure after 3 attempts (pull): buildah pull failed" },
    });
    expect((await store.getBuild(env.id, env.lastBuild!.id))!.attempts).toBe(3);
    expect((await logOf("t1", env.lastBuild!.id)).match(/Retrying\./g)).toHaveLength(2);
  });

  it("succeeds on a retry after an infrastructure failure, a thrown runner error counting as one", async () => {
    const runner = new FakeRunner([
      failing({ outcome: "infrastructure_failed", stage: "push", message: "unauthorized" }),
      async () => { throw new Error("pods is forbidden"); },
      pushed(5),
    ]);
    const { builder, create, store, drain } = setup({ runner });
    const env = await create();
    expect(await drain(builder())).toEqual(["succeeded"]);
    expect(runner.jobs.map((job) => job.attempt)).toEqual([1, 2, 3]);
    expect(await store.get("t1", env.id)).toMatchObject({ status: "ready", image: `${REPO}@${digest(5)}` });
  });

  it("fails an image the verification rejects without retrying, and retries a verification infrastructure failure", async () => {
    const verifier = new FakeVerifier([{ ok: false, kind: "image", message: "/home/user is owned by root:root, not user:user" }]);
    const runner = new FakeRunner([pushed(1)]);
    const { builder, create, store, drain } = setup({ runner, verifier });
    const env = await create();
    const worker = builder();
    expect(await drain(worker)).toEqual(["failed"]);
    expect(await store.get("t1", env.id)).toMatchObject({
      status: "failed", image: null, lastBuild: { errorCode: BUILD_ERRORS.verification, errorMessage: "/home/user is owned by root:root, not user:user" },
    });
    expect(runner.jobs).toHaveLength(1);

    verifier.results = [{ ok: false, kind: "infrastructure", message: "Sandbox create answered HTTP 503" }, { ok: true, manifest: MANIFEST }];
    verifier.images.length = 0;
    await store.rebuild(TENANT, env.id);
    expect(await drain(worker)).toEqual(["succeeded"]);
    expect(runner.jobs.slice(1).map((job) => job.attempt)).toEqual([1, 2]);
    expect(await store.get("t1", env.id)).toMatchObject({ status: "ready", manifest: MANIFEST });
  });

  it("stops a build a newer change superseded, deleting its pod; the final image is the latest script's", async () => {
    const first = blocking();
    const runner = new FakeRunner([first, pushed(2)]);
    const { builder, create, store, clock, logOf, waitIdle } = setup({ runner });
    const env = await create({ initScript: "echo v1\n" });
    const worker = builder();
    await worker.poll();
    await first.started;
    const changed = await store.update(TENANT, env.id, { initScript: "echo v2\n" });

    await clock.advance(BUILD_TIMING.renewMs);
    expect(await waitIdle(worker)).toEqual(["superseded"]);
    expect(runner.deleted).toEqual([`${env.lastBuild!.id}/1`]);
    expect(await logOf("t1", env.lastBuild!.id)).toContain("superseded this build; its build pod was deleted");
    expect(await store.getBuild(env.id, env.lastBuild!.id)).toMatchObject({ status: "superseded", image: null });
    expect(await store.get("t1", env.id)).toMatchObject({ status: "pending", image: null });

    await worker.poll();
    expect(await waitIdle(worker)).toEqual(["succeeded"]);
    expect(runner.jobs.map((job) => job.context["init.sh"])).toEqual(["echo v1\n", "echo v2\n"]);
    expect(await store.get("t1", env.id)).toMatchObject({
      status: "ready", image: `${REPO}@${digest(2)}`, initScript: "echo v2\n", lastBuild: { id: changed!.lastBuild!.id, status: "succeeded" },
    });
    // The superseded pod finishing late changes nothing.
    first.finish({ outcome: "pushed", digest: digest(9) });
    await settle();
    expect((await store.get("t1", env.id))!.image).toBe(`${REPO}@${digest(2)}`);
  });

  it("fails a build that has not finished 60 minutes after its first claim, deleting its pod and keeping the image", async () => {
    const step = blocking();
    const runner = new FakeRunner([pushed(1), step]);
    const { builder, create, store, clock, drain, waitIdle } = setup({ runner });
    const env = await create();
    const worker = builder();
    await drain(worker);
    await store.rebuild(TENANT, env.id);
    await worker.poll();
    await step.started;
    await clock.advance(BUILD_TIMING.timeoutMs - 1);
    expect(worker.runningCount).toBe(1);
    await clock.advance(1);
    expect(await waitIdle(worker)).toEqual(["failed"]);
    expect(runner.deleted).toHaveLength(2);
    expect(await store.get("t1", env.id)).toMatchObject({
      status: "failed", image: `${REPO}@${digest(1)}`,
      lastBuild: { errorCode: BUILD_ERRORS.timeout, errorMessage: "The build did not finish within 60 minutes." },
    });
  });

  it("counts the timeout from the first claim: a build reclaimed too late fails without another pod", async () => {
    const { builder, create, store, clock, runner, drain } = setup();
    const env = await create();
    await store.claimBuild("crashed-builder", BUILD_TIMING.leaseMs);
    await clock.advance(BUILD_TIMING.timeoutMs + 1);
    expect(await drain(builder())).toEqual(["failed"]);
    expect(runner.jobs).toHaveLength(0);
    expect(runner.cleanups).toEqual([env.lastBuild!.id]);
    expect(await store.get("t1", env.id)).toMatchObject({ status: "failed", lastBuild: { errorCode: BUILD_ERRORS.timeout } });
  });

  it("after a restart sweeps what the previous builder left, reclaims its build once the lease expires and continues its log", async () => {
    const { builder, create, store, clock, runner, verifier, logs, logOf, waitIdle } = setup();
    const env = await create();
    const crashed = (await store.claimBuild("crashed-builder", BUILD_TIMING.leaseMs))!;
    const key = environmentBuildLogKey("t1", crashed.build.id);
    await logs.write(key, { text: "[oma-builder] Attempt 1: building oma-base\n==> Pulling the Base Image\n", start: 0 });

    // What the crashed builder left: the running attempt's pod, which the
    // reclaim removes, and a superseded build's pod and Sandbox, which the sweep does.
    const old = await create();
    const oldBuild = (await store.listBuilds(old.id))[0]!;
    await store.update(TENANT, old.id, { initScript: "echo v2\n" });
    runner.pods = [
      { environmentId: env.id, buildId: crashed.build.id, attempt: 1 },
      { environmentId: old.id, buildId: oldBuild.id, attempt: 1 },
    ];
    verifier.sandboxes = [{ environmentId: old.id, buildId: oldBuild.id, attempt: 1 }];

    const restarted = builder("builder-b");
    await restarted.start();
    expect(runner.swept).toEqual([{ environmentId: old.id, buildId: oldBuild.id, attempt: 1 }]);
    expect(runner.pods).toEqual([{ environmentId: env.id, buildId: crashed.build.id, attempt: 1 }]);
    expect(verifier.swept).toEqual([{ environmentId: old.id, buildId: oldBuild.id, attempt: 1 }]);
    expect(verifier.sweeps).toBe(1);
    expect(runner.jobs).toHaveLength(0);
    expect(runner.jobs).toHaveLength(0);
    expect(await store.get("t1", env.id)).toMatchObject({ status: "building" });

    await clock.advance(BUILD_TIMING.leaseMs);
    await waitIdle(restarted);
    expect(runner.cleanups).toEqual([crashed.build.id]);
    expect(runner.jobs.map((job) => [job.buildId, job.attempt])).toEqual(expect.arrayContaining([[crashed.build.id, 2], [(await store.listBuilds(old.id))[0]!.id, 1]]));
    expect(runner.jobs).toHaveLength(2);
    expect(await store.get("t1", env.id)).toMatchObject({ status: "ready", image: `${REPO}@${digest(1)}` });
    const log = await logOf("t1", crashed.build.id);
    expect(log.startsWith("[oma-builder] Attempt 1: building oma-base\n==> Pulling the Base Image\n")).toBe(true);
    expect(log).toContain("The previous builder stopped during this build; resuming as attempt 2");
  });

  it("on stop deletes its pods and releases their leases, so the next builder resumes at once", async () => {
    const step = blocking();
    const runner = new FakeRunner([step, pushed(4)]);
    const { builder, create, store, drain } = setup({ runner });
    const env = await create();
    const stopping = builder();
    await stopping.poll();
    await step.started;
    await stopping.stop();
    expect(runner.deleted).toEqual([`${env.lastBuild!.id}/1`]);
    expect(await store.getBuild(env.id, env.lastBuild!.id)).toMatchObject({ status: "running", attempts: 1 });

    expect(await drain(builder("builder-b"))).toEqual(["succeeded"]);
    expect(runner.cleanups).toEqual([env.lastBuild!.id]);
    expect(await store.get("t1", env.id)).toMatchObject({ status: "ready", image: `${REPO}@${digest(4)}` });
  });

  it("stops a build whose lease another builder took over, writing nothing", async () => {
    let renewalsFail = false;
    const step = blocking();
    const runner = new FakeRunner([step, pushed(6)]);
    const { builder, create, store, clock, waitIdle, logOf } = setup({
      runner,
      queue: (store) => new Proxy(store, {
        get(target, name, receiver) {
          if (name === "renewBuild" && renewalsFail) return async () => { throw new Error("connection terminated"); };
          const value = Reflect.get(target, name, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    });
    const env = await create();
    const partitioned = builder();
    await partitioned.poll();
    await step.started;
    renewalsFail = true;
    await clock.advance(BUILD_TIMING.leaseMs);
    const other = builder("builder-b");
    renewalsFail = false;
    await other.poll();
    await waitIdle(other);
    expect(await store.get("t1", env.id)).toMatchObject({ status: "ready", image: `${REPO}@${digest(6)}` });

    const othersLog = await logOf("t1", env.lastBuild!.id);
    expect(othersLog).toContain(`Ready: ${REPO}@${digest(6)}`);
    await clock.advance(BUILD_TIMING.renewMs);
    expect(await waitIdle(partitioned)).toEqual(["lost"]);
    expect(runner.deleted).toContain(`${env.lastBuild!.id}/1`);
    step.finish({ outcome: "pushed", digest: digest(8) });
    await settle();
    expect((await store.get("t1", env.id))!.image).toBe(`${REPO}@${digest(6)}`);
    // The builder that lost the lease leaves the new owner's log alone.
    expect(await logOf("t1", env.lastBuild!.id)).toBe(othersLog);
  });

  it("runs every claimable build at once: no concurrency limit", async () => {
    const steps = Array.from({ length: 5 }, () => blocking());
    const runner = new FakeRunner(steps);
    const { builder, create, store } = setup({ runner });
    const envs = await Promise.all(steps.map((_, i) => create({ baseImage: i % 2 ? "oma-media" : "oma-base" })));
    const worker = builder();
    expect(await worker.poll()).toBe(5);
    await Promise.all(steps.map((step) => step.started));
    expect(worker.runningCount).toBe(5);
    expect(runner.jobs.map((job) => job.baseImage)).toEqual([BASE, MEDIA, BASE, MEDIA, BASE]);
    for (const env of envs) expect((await store.get("t1", env.id))!.status).toBe("building");
  });

  it("starts claiming even when the startup sweep fails", async () => {
    const runner = new FakeRunner([pushed(1)]);
    runner.sweep = async () => { throw new Error("pods is forbidden"); };
    const { builder, create, store, clock } = setup({ runner });
    const env = await create();
    const worker = builder();
    await worker.start();
    await clock.advance(BUILD_TIMING.pollMs);
    while (worker.runningCount) await settle();
    expect(await store.get("t1", env.id)).toMatchObject({ status: "ready" });
  });

  it("sweeps periodically, sparing its own running attempts and those another builder's lease covers", async () => {
    const step = blocking();
    const runner = new FakeRunner([step]);
    const { builder, create, clock, store, verifier } = setup({ runner });
    const env = await create();
    const other = await create();
    const worker = builder();
    await worker.start();
    await clock.advance(BUILD_TIMING.pollMs);
    await step.started;
    const elsewhere = await store.getBuild(other.id, other.lastBuild!.id);
    expect(elsewhere).toMatchObject({ status: "running", attempts: 1 });
    // Pretend the other build runs under another builder: its pod and an older attempt's.
    runner.pods = [
      { environmentId: env.id, buildId: env.lastBuild!.id, attempt: 1 },
      { environmentId: other.id, buildId: other.lastBuild!.id, attempt: 0 },
    ];
    await clock.advance(BUILD_TIMING.sweepMs);
    expect(runner.sweeps.length).toBeGreaterThanOrEqual(2);
    expect(runner.swept).toEqual([{ environmentId: other.id, buildId: other.lastBuild!.id, attempt: 0 }]);
    expect(await runner.sweeps.at(-1)!({ environmentId: other.id, buildId: other.lastBuild!.id, attempt: 1 })).toBe(true);
    expect(verifier.sweeps).toBeGreaterThanOrEqual(2);
  });
});
