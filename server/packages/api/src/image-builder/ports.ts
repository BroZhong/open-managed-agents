/**
 * The image builder's seams (ADR-0024 "Building"). The orchestration in
 * `builder.ts` depends only on these and on the Environment Build queue, so
 * every transition, retry, timeout, supersede and reclaim is testable without
 * a cluster.
 */

/** Time as the builder waits on it. */
export interface Clock {
  now(): number;
  /** Resolves after `ms`; rejects with the signal's reason when it aborts first. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) => new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); reject(signal!.reason); };
    signal?.addEventListener("abort", abort, { once: true });
  }),
};

/** The files of one build's context, as `build-context.ts` generates them. */
export type BuildContextFiles = Readonly<Record<string, string>>;

/** Which attempt of which build a pod or a verification Sandbox belongs to. */
export interface BuildAttemptRef {
  environmentId: string;
  buildId: string;
  attempt: number;
}

/**
 * Whether what an attempt left may stay: its attempt is still running here
 * or under another builder's lease. Anything else is swept.
 */
export type KeepAttempt = (ref: BuildAttemptRef) => Promise<boolean>;

/** One attempt of one Environment Build, ready to run. */
export interface BuildJob extends BuildAttemptRef {
  /** The Base Image, pinned by digest. */
  baseImage: string;
  /** Where the image is pushed: `<repository>:<deployment>-<envId>-<buildId>`. */
  target: string;
  /** Dockerfile, init script, build.env and the pod's driver. */
  context: BuildContextFiles;
  /** A per-attempt token the context's failure markers carry, so script output cannot imitate them. */
  nonce: string;
}

/**
 * How an attempt ended:
 * - `pushed`: the image is in the registry under `digest`;
 * - `script_failed`: the init script (or, after it, the manifest step, which
 *   only fails on what the script left) exited non-zero — never retried;
 * - `infrastructure_failed`: the pod could not be scheduled or started, the
 *   Base Image pull, the build tooling or the push failed — retried.
 */
export type BuildRunResult =
  | { outcome: "pushed"; digest: string }
  | { outcome: "script_failed"; message: string }
  | { outcome: "infrastructure_failed"; stage: string; message: string };

/** Streams log text to the build's log as it arrives. */
export type BuildLogSink = (text: string) => void;

/** Runs build attempts in isolated pods (Kubernetes: `pod-runner.ts`). */
export interface BuildRunner {
  /**
   * Run one attempt to its end and delete its pod. Aborting `signal` stops
   * it: the pod is deleted and the promise rejects with the signal's reason.
   */
  run(job: BuildJob, io: { log: BuildLogSink; signal: AbortSignal }): Promise<BuildRunResult>;
  /** Delete whatever every earlier attempt of `buildId` left behind (a reclaimed build). */
  cleanup(buildId: string): Promise<void>;
  /** Delete this deployment's build pods that `keep` rejects. Resolves with the number deleted. */
  sweep(keep: KeepAttempt): Promise<number>;
}

/**
 * How verifying a pushed image ended: `ok` with the image's manifest;
 * `image` when the image itself is unusable (not retried); `infrastructure`
 * when the claim or the Sandbox's daemon failed (retried).
 */
export type VerificationResult =
  | { ok: true; manifest: Record<string, unknown> }
  | { ok: false; kind: "image" | "infrastructure"; message: string };

/** Claims a Sandbox with a new image and checks it before it may serve. */
export interface ImageVerifier {
  /** Claim one Sandbox with `image`, check it and destroy it. */
  verify(image: string, io: { ref: BuildAttemptRef; log: BuildLogSink; signal: AbortSignal }): Promise<VerificationResult>;
  /** Destroy this deployment's verification Sandboxes that `keep` rejects. Resolves with the number destroyed. */
  sweep(keep: KeepAttempt): Promise<number>;
}
