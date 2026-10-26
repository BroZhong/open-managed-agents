import { createHash } from "node:crypto";
import { nanoid } from "nanoid";
import type { EnvironmentBaseImage } from "./interfaces/environment-store.js";

export const ENVIRONMENT_BASE_IMAGES = ["oma-base", "oma-media"] as const satisfies readonly EnvironmentBaseImage[];

/**
 * The built-in Environment a Sandboxed Agent runs in unless it names another
 * (ADR-0024): video-production, which `sandbox/environments/` defines.
 */
export const DEFAULT_ENVIRONMENT_ID = "env_video_production";

/** A new Tenant Environment id. Built-in Environments keep their fixed ids. */
export const newEnvironmentId = () => `env_${nanoid()}`;
export const newEnvironmentBuildId = () => `envb_${nanoid()}`;

/**
 * What an Environment Build builds, as one hash: the Base Image and the init
 * script. Variables are not part of it; changing them never builds.
 */
export function environmentDefinitionSha256(baseImage: EnvironmentBaseImage, initScript: string): string {
  return createHash("sha256").update(JSON.stringify({ baseImage, initScript })).digest("hex");
}

/** A build lease's length as every Environment Build queue accepts it: a positive integer of milliseconds. */
export function validateEnvironmentBuildLeaseMs(leaseMs: number): void {
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) throw new RangeError("Environment Build lease must be a positive integer of milliseconds");
}
