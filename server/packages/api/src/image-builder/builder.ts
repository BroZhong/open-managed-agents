import { randomBytes } from "node:crypto";
import {
  environmentBuildLogKey,
  type ClaimedEnvironmentBuild,
  type EnvironmentBaseImage,
  type EnvironmentBuildLease,
  type EnvironmentBuildLogStore,
  type EnvironmentBuildQueue,
  type EnvironmentStore,
} from "@oma-server/store";
import { buildContext } from "./build-context.js";
import { BuildLog } from "./build-log.js";
import type { BuildAttemptRef, BuildJob, BuildRunner, Clock, ImageVerifier } from "./ports.js";

export interface EnvironmentBuilderConfig {
  /** This builder's lease owner, unique per process. */
  owner: string;
  /** The deployment environment (`test`, `production`): the image tag's prefix. */
  deployment: string;
  /** Where Environment images are pushed, e.g. `registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-environments`. */
  repository: string;
  /** Each Base Image pinned by digest (configuration, not code). */
  baseImages: Readonly<Record<EnvironmentBaseImage, string>>;
  /** Defaults every build's script sees first (`PLATFORM_DEFAULT_ENV`). */
  platformDefaults: Readonly<Record<string, string>>;
  /** The build-time egress proxy and its explicit exceptions. */
  proxy: { url: string; noProxy: string } | null;
}

/** ADR-0024's rules, and the cadence of the builder's loops. */
export interface EnvironmentBuilderTiming {
  /** A build fails when it has not finished this long after its first claim. */
  timeoutMs: number;
  /** One attempt and at most two retries after infrastructure failures. */
  maxAttempts: number;
  leaseMs: number;
  renewMs: number;
  pollMs: number;
  logFlushMs: number;
  sweepMs: number;
}

export const BUILD_TIMING: EnvironmentBuilderTiming = {
  timeoutMs: 60 * 60_000,
  maxAttempts: 3,
  leaseMs: 90_000,
  // A newer change stops a superseded build within one renewal.
  renewMs: 10_000,
  pollMs: 5_000,
  // Readers poll every 2 s.
  logFlushMs: 2_000,
  sweepMs: 10 * 60_000,
};

export interface EnvironmentBuilderDeps {
  /** Claims builds; `getBuild` tells the sweep which attempts still run. */
  queue: EnvironmentBuildQueue & Pick<EnvironmentStore, "getBuild">;
  runner: BuildRunner;
  verifier: ImageVerifier;
  logs: EnvironmentBuildLogStore;
  clock: Clock;
  config: EnvironmentBuilderConfig;
  timing?: Partial<EnvironmentBuilderTiming>;
  logger?: Pick<Console, "info" | "warn" | "error">;
  /** Per-attempt marker tokens; tests inject fixed ones. */
  nonce?: () => string;
}

/** Why a running build stopped before it reached an outcome of its own. */
type StopReason = "superseded" | "lost" | "timeout" | "stopping";

class BuildStopped extends Error {
  constructor(readonly reason: StopReason) {
    super(`Environment Build stopped: ${reason}`);
    this.name = "BuildStopped";
  }
}

/** How {@link EnvironmentBuilder.runBuild} left a build. */
export type BuildOutcome = "succeeded" | "failed" | "superseded" | "lost" | "released";

type AttemptResult =
  | { kind: "succeeded"; image: string; manifest: Record<string, unknown> }
  | { kind: "failed"; code: string; message: string }
  | { kind: "retry"; stage: string; message: string };

/** Build error codes, as `lastBuild.errorCode` shows them. */
export const BUILD_ERRORS = {
  script: "environment_build_script_failed",
  verification: "environment_build_verification_failed",
  infrastructure: "environment_build_infrastructure_failed",
  timeout: "environment_build_timed_out",
  baseImage: "environment_build_base_image_unavailable",
} as const;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The image builder (ADR-0024 "Building"). It claims Environment Builds from
 * PostgreSQL with a lease (ADR-0018) — every claimable build at once, no
 * concurrency limit — and runs each: an attempt in a build pod, then a
 * Sandbox claimed with the pushed image for verification, and only then the
 * image replaces the Environment's. While a build runs its lease is renewed;
 * a newer change supersedes it (the pod is deleted, nothing is written); it
 * fails after 60 minutes from its first claim. A script failure is final;
 * an infrastructure failure is retried twice. A build whose builder stopped
 * is reclaimed when its lease expires, and what the earlier attempt left is
 * removed first.
 */
export class EnvironmentBuilder {
  private readonly timing: EnvironmentBuilderTiming;
  private readonly logger: Pick<Console, "info" | "warn" | "error">;
  private readonly nonce: () => string;
  private readonly stopping = new AbortController();
  /** Running builds by `<buildId>/<attempt>` of their claim. */
  private readonly running = new Map<string, Promise<BuildOutcome>>();
  /** Attempts whose pod may exist, as `<buildId>/<attempt>`: the sweep spares them. */
  private readonly active = new Set<string>();
  private loop?: Promise<void>;

  constructor(private readonly deps: EnvironmentBuilderDeps) {
    this.timing = { ...BUILD_TIMING, ...deps.timing };
    this.logger = deps.logger ?? console;
    this.nonce = deps.nonce ?? (() => randomBytes(12).toString("hex"));
  }

  /**
   * Remove what a previous builder left, then claim and run builds until
   * {@link stop}. A failed sweep does not keep builds waiting: the next
   * periodic sweep tries again.
   */
  async start(): Promise<void> {
    await this.sweep().catch((error) => this.logger.error(`environment_build_sweep: ${errorText(error)}`));
    this.loop = this.claimLoop();
  }

  /**
   * Stop claiming; every running build deletes its pod and releases its
   * lease so the next builder resumes it at once.
   */
  async stop(): Promise<void> {
    this.stopping.abort();
    await this.loop;
    await Promise.allSettled(this.running.values());
  }

  /** Builds being run now. */
  get runningCount(): number {
    return this.running.size;
  }

  /** Claim every claimable build and start each; resolves with how many started. */
  async poll(): Promise<number> {
    let started = 0;
    while (!this.stopping.signal.aborted) {
      const claimed = await this.deps.queue.claimBuild(this.deps.config.owner, this.timing.leaseMs);
      if (!claimed) break;
      started++;
      this.logger.info(`environment_build_start build=${claimed.build.id} environment=${claimed.build.environmentId} attempt=${claimed.lease.attempt} reclaimed=${claimed.reclaimed}`);
      const key = `${claimed.build.id}/${claimed.lease.attempt}`;
      const run = this.runBuild(claimed).catch((error): BuildOutcome => {
        this.logger.error(`environment_build ${claimed.build.id}: ${errorText(error)}`);
        return "lost";
      }).then((outcome) => {
        this.logger.info(`environment_build_end build=${claimed.build.id} environment=${claimed.build.environmentId} attempt=${claimed.lease.attempt} outcome=${outcome}`);
        return outcome;
      }).finally(() => this.running.delete(key));
      this.running.set(key, run);
    }
    return started;
  }

  /**
   * Delete build pods and verification Sandboxes no running attempt owns:
   * what a superseded, finished or abandoned attempt left when its builder
   * stopped abruptly. An attempt another builder's lease still covers is
   * kept; a reclaim removes its leftovers itself.
   */
  async sweep(): Promise<void> {
    const keep = async (ref: BuildAttemptRef) => {
      if (this.active.has(`${ref.buildId}/${ref.attempt}`)) return true;
      const build = await this.deps.queue.getBuild(ref.environmentId, ref.buildId);
      return build?.status === "running" && build.attempts === ref.attempt;
    };
    const pods = await this.deps.runner.sweep(keep);
    const sandboxes = await this.deps.verifier.sweep(keep);
    if (pods || sandboxes) this.logger.info(`environment_build_sweep pods=${pods} sandboxes=${sandboxes}`);
  }

  /** Run one claimed build until it has an outcome, is superseded, loses its lease or the builder stops. */
  async runBuild(claimed: ClaimedEnvironmentBuild): Promise<BuildOutcome> {
    const { build } = claimed;
    const { clock, queue } = this.deps;
    let lease = claimed.lease;
    const key = environmentBuildLogKey(build.tenantId, build.id);
    const log = await BuildLog.open(this.deps.logs, key, () => clock.now())
      .catch(() => new BuildLog(this.deps.logs, key, () => clock.now()));
    const control = new AbortController();
    const stop = (reason: StopReason) => { if (!control.signal.aborted) control.abort(new BuildStopped(reason)); };
    const onStopping = () => stop("stopping");
    this.stopping.signal.addEventListener("abort", onStopping, { once: true });
    if (this.stopping.signal.aborted) stop("stopping");
    const background = new AbortController();
    const every = (ms: number, tick: () => Promise<void>) => void (async () => {
      while (!background.signal.aborted) {
        await clock.sleep(ms, background.signal);
        await tick().catch((error) => this.logger.warn(`environment_build ${build.id}: ${errorText(error)}`));
      }
    })().catch(() => {});
    every(this.timing.renewMs, async () => {
      const renewal = await queue.renewBuild(lease, this.timing.leaseMs);
      if (renewal !== "renewed") stop(renewal);
    });
    // Once another builder may own the build, its log is theirs to write.
    let ownsLog = true;
    const flush = (final = false) => (ownsLog ? log.flush(final) : Promise.resolve());
    every(this.timing.logFlushMs, () => flush());
    const deadline = build.startedAt!.getTime() + this.timing.timeoutMs;
    void clock.sleep(Math.max(0, deadline - clock.now()), background.signal).then(() => stop("timeout"), () => {});

    /** Write the log, then the outcome: a reader that sees the outcome finds the whole log. */
    const finish = async (result: Extract<AttemptResult, { kind: "succeeded" | "failed" }>): Promise<BuildOutcome> => {
      if (result.kind === "failed") log.note(`Build failed (${result.code}): ${result.message}`);
      else log.note(`Ready: ${result.image} now serves this Environment.`);
      await flush(true).catch(() => {});
      const recorded = result.kind === "succeeded"
        ? await queue.succeedBuild(lease, { image: result.image, manifest: result.manifest })
        : await queue.failBuild(lease, { code: result.code, message: result.message });
      if (recorded) return result.kind;
      // Superseded, or taken over by another builder: either way not ours to record.
      ownsLog = false;
      return "lost";
    };

    try {
      await queue.recordBuildProgress(lease, { logKey: key });
      if (claimed.reclaimed) {
        log.note(`The previous builder stopped during this build; resuming as attempt ${lease.attempt} after removing what earlier attempts left.`);
        await this.deps.runner.cleanup(build.id);
      }
      for (;;) {
        if (clock.now() >= deadline) stop("timeout");
        control.signal.throwIfAborted();
        log.note(`Attempt ${lease.attempt}: building ${build.baseImage} for Environment ${build.environmentId} (build ${build.id}).`);
        const result = await this.attempt(claimed, lease, log, control.signal);
        if (result.kind !== "retry") return await finish(result);
        if (lease.attempt >= this.timing.maxAttempts) {
          return await finish({
            kind: "failed", code: BUILD_ERRORS.infrastructure,
            message: `Infrastructure failure after ${lease.attempt} attempts (${result.stage}): ${result.message}`,
          });
        }
        log.note(`Infrastructure failure (${result.stage}): ${result.message}. Retrying.`);
        const next = await queue.retryBuild(lease, this.timing.leaseMs);
        if (!next) {
          const renewal = await queue.renewBuild(lease, this.timing.leaseMs);
          throw new BuildStopped(renewal === "superseded" ? "superseded" : "lost");
        }
        lease = next;
      }
    } catch (error) {
      const reason = error instanceof BuildStopped ? error.reason
        : control.signal.reason instanceof BuildStopped ? control.signal.reason.reason : undefined;
      switch (reason) {
        case "superseded":
          log.note("A newer change to the Environment superseded this build; its build pod was deleted.");
          return "superseded";
        case "timeout":
          return await finish({ kind: "failed", code: BUILD_ERRORS.timeout, message: `The build did not finish within ${Math.round(this.timing.timeoutMs / 60_000)} minutes.` });
        case "stopping":
          log.note("The image builder is stopping; the next builder resumes this build.");
          await flush(true).catch(() => {});
          ownsLog = false;
          await queue.releaseBuild(lease).catch(() => false);
          return "released";
        case "lost":
          ownsLog = false;
          return "lost";
        default:
          // The database or the log store failed: write nothing more; the
          // lease lapses and the build is reclaimed as a new attempt.
          this.logger.error(`environment_build ${build.id}: ${errorText(error)}`);
          log.note(`The builder failed: ${errorText(error)}. The build will be resumed.`);
          return "lost";
      }
    } finally {
      background.abort();
      this.stopping.signal.removeEventListener("abort", onStopping);
      await flush(true).catch(() => {});
    }
  }

  private async attempt(
    claimed: ClaimedEnvironmentBuild, lease: EnvironmentBuildLease, log: BuildLog, signal: AbortSignal,
  ): Promise<AttemptResult> {
    const { build } = claimed;
    const { config } = this.deps;
    const baseImage = config.baseImages[build.baseImage];
    if (!baseImage) return { kind: "failed", code: BUILD_ERRORS.baseImage, message: `No ${build.baseImage} Base Image is configured.` };
    await this.deps.queue.recordBuildProgress(lease, { baseImageDigest: baseImage.slice(baseImage.indexOf("@") + 1) });
    const nonce = this.nonce();
    const job: BuildJob = {
      buildId: build.id,
      environmentId: build.environmentId,
      attempt: lease.attempt,
      baseImage,
      target: `${config.repository}:${config.deployment}-${build.environmentId}-${build.id}`,
      nonce,
      context: buildContext({
        environmentId: build.environmentId, buildId: build.id, baseImage, initScript: build.initScript,
        env: claimed.env, platformDefaults: config.platformDefaults, proxy: config.proxy, nonce,
      }),
    };
    const activeKey = `${build.id}/${lease.attempt}`;
    // Before the pod or Sandbox exists, so no sweep can take it for a leftover.
    this.active.add(activeKey);
    try {
      let run;
      try {
        run = await this.deps.runner.run(job, { log: (text) => log.append(text), signal });
      } catch (error) {
        signal.throwIfAborted();
        return { kind: "retry", stage: "pod", message: errorText(error) };
      }
      if (run.outcome === "script_failed") return { kind: "failed", code: BUILD_ERRORS.script, message: run.message };
      if (run.outcome === "infrastructure_failed") return { kind: "retry", stage: run.stage, message: run.message };

      const image = `${config.repository}@${run.digest}`;
      log.note(`Pushed ${image}. Verifying it in a Sandbox claimed from the Warm Pool.`);
      let verified;
      try {
        verified = await this.deps.verifier.verify(image, { ref: job, log: (text) => log.note(text), signal });
      } catch (error) {
        signal.throwIfAborted();
        return { kind: "retry", stage: "verification", message: errorText(error) };
      }
      if (verified.ok) return { kind: "succeeded", image, manifest: verified.manifest };
      if (verified.kind === "image") return { kind: "failed", code: BUILD_ERRORS.verification, message: verified.message };
      return { kind: "retry", stage: "verification", message: verified.message };
    } finally {
      this.active.delete(activeKey);
    }
  }

  private async claimLoop(): Promise<void> {
    let lastSweep = this.deps.clock.now();
    while (!this.stopping.signal.aborted) {
      try {
        await this.poll();
        if (this.deps.clock.now() - lastSweep >= this.timing.sweepMs) {
          lastSweep = this.deps.clock.now();
          await this.sweep();
        }
      } catch (error) {
        this.logger.error(`environment_build_poll: ${errorText(error)}`);
      }
      await this.deps.clock.sleep(this.timing.pollMs, this.stopping.signal).catch(() => {});
    }
  }
}
