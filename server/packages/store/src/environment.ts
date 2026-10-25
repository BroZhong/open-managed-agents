import { createHash } from "node:crypto";
import { nanoid } from "nanoid";
import type { EnvironmentBaseImage } from "./interfaces/environment-store.js";

export const ENVIRONMENT_BASE_IMAGES = ["oma-base", "oma-media"] as const satisfies readonly EnvironmentBaseImage[];

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
