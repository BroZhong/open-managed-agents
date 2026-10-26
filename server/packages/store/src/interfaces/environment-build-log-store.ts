/**
 * The kept tail of an Environment Build's log (ADR-0024: the last 1 MiB, in
 * OSS at `__oma/environment-builds/<tenantId or platform>/<buildId>.log`).
 * The image builder rewrites it while the build runs; the API serves it.
 */
export interface EnvironmentBuildLog {
  /** UTF-8 text of at most {@link ENVIRONMENT_BUILD_LOG_MAX_BYTES}; after a cut it starts at a line. */
  text: string;
  /** Byte offset of `text` in the whole log: how many bytes before it were dropped. */
  start: number;
}

export const ENVIRONMENT_BUILD_LOG_MAX_BYTES = 1024 * 1024;

export interface EnvironmentBuildLogStore {
  /** Replace the log kept at `key`. */
  write(key: string, log: EnvironmentBuildLog): Promise<void>;
  /** The log kept at `key`; null when none was written yet. */
  read(key: string): Promise<EnvironmentBuildLog | null>;
}

const ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Where a build's log is kept: under its Tenant, or `platform` for a Built-in Environment. */
export function environmentBuildLogKey(tenantId: string | null, buildId: string): string {
  if ((tenantId !== null && !ID.test(tenantId)) || !ID.test(buildId) || tenantId === "platform") {
    throw new Error("Invalid Environment Build log identity");
  }
  return `__oma/environment-builds/${tenantId ?? "platform"}/${buildId}.log`;
}
