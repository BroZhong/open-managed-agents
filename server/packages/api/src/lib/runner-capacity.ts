import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { DEFAULT_RUNNER_CAPACITY, isRunnerCapacity } from "@oma-server/session-router";

/**
 * The Runner Capacity from RUNNER_CAPACITY (ADR-0026): a positive integer,
 * the Router's default when unset. Anything else refuses the Runner's start
 * rather than run it with a capacity nobody configured.
 */
export function runnerCapacityFromEnv(env: NodeJS.ProcessEnv): number {
  const raw = env.RUNNER_CAPACITY;
  if (raw === undefined) return DEFAULT_RUNNER_CAPACITY;
  const capacity = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  if (!isRunnerCapacity(capacity)) throw new RangeError(`RUNNER_CAPACITY must be a positive integer, not "${raw}"`);
  return capacity;
}

/** The Runner's Pod, from the downward API's POD_NAME; outside Kubernetes, its host. */
export function runnerPodName(env: NodeJS.ProcessEnv): string {
  return env.POD_NAME?.trim() || hostname();
}

/**
 * The owner this Runner process claims input as: its Pod's name and a suffix
 * of its own, so PostgreSQL shows which Pod holds each claim and a restarted
 * container never takes its predecessor's claims for its own (ADR-0026).
 */
export function runnerClaimOwnerId(env: NodeJS.ProcessEnv, suffix: string = randomUUID().slice(0, 8)): string {
  return `${runnerPodName(env)}_${suffix}`;
}
