import { randomUUID } from "node:crypto";

/** N of ADR-0026 when RUNNER_CAPACITY is unset. */
const DEFAULT_RUNNER_CAPACITY = 50;

/**
 * The Runner Capacity from RUNNER_CAPACITY (ADR-0026): a positive integer,
 * 50 when unset. Anything else refuses the Runner's start rather than run
 * it with a capacity nobody configured.
 */
export function runnerCapacityFromEnv(env: NodeJS.ProcessEnv): number {
  const raw = env.RUNNER_CAPACITY;
  if (raw === undefined) return DEFAULT_RUNNER_CAPACITY;
  const capacity = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  if (!Number.isSafeInteger(capacity) || capacity < 1) throw new RangeError(`RUNNER_CAPACITY must be a positive integer, not "${raw}"`);
  return capacity;
}

/**
 * The owner this Runner process claims input as: its Pod's name, from the
 * downward API, and a suffix of its own, so PostgreSQL shows which Pod holds
 * each claim and a restarted container never takes its predecessor's claims
 * for its own (ADR-0026).
 */
export function runnerClaimOwnerId(env: NodeJS.ProcessEnv, suffix: string = randomUUID().slice(0, 8)): string {
  return `${env.POD_NAME?.trim() || "host"}_${suffix}`;
}
