import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ENVIRONMENT_BASE_IMAGES,
  type EnvironmentBaseImage,
  type EnvironmentBuildQueue,
  type EnvironmentOwner,
  type EnvironmentStore,
  type EnvironmentStoreUpdateInput,
  type EnvironmentVariable,
} from "@oma-server/store";
import { ENVIRONMENT_VARIABLE_NAME, isReservedEnvironmentVariable } from "@oma-server/sandbox";

/**
 * A Built-in Environment as the repository defines it (ADR-0024):
 * `sandbox/environments/<name>/environment.json` and its `init.sh`.
 */
export interface BuiltInEnvironmentDefinition {
  id: string;
  name: string;
  description: string;
  baseImage: EnvironmentBaseImage;
  env: EnvironmentVariable[];
  initScript: string;
}

const PLATFORM: EnvironmentOwner = { ownerType: "platform" };
const ID = /^env_[a-z0-9_]+$/;

function invalid(dir: string, message: string): never {
  throw new Error(`Built-in Environment ${dir}: ${message}`);
}

/** One definition, checked as the API checks a Tenant's, but with platform secrets. */
export function parseBuiltInEnvironment(dir: string, json: string, initScript: string): BuiltInEnvironmentDefinition {
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { invalid(dir, "environment.json is not JSON"); }
  const definition = raw as Record<string, unknown>;
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) invalid(dir, "environment.json is not an object");
  const keys = Object.keys(definition).sort().join(",");
  if (keys !== "baseImage,description,env,id,name") invalid(dir, `unexpected fields ${keys}`);
  const { id, name, description, baseImage, env } = definition as Record<string, unknown>;
  if (typeof id !== "string" || !ID.test(id)) invalid(dir, "id must match env_[a-z0-9_]+");
  if (name !== dir) invalid(dir, "name must be its directory's name");
  if (typeof description !== "string") invalid(dir, "description must be a string");
  if (!ENVIRONMENT_BASE_IMAGES.includes(baseImage as EnvironmentBaseImage)) invalid(dir, `baseImage must be one of ${ENVIRONMENT_BASE_IMAGES.join(", ")}`);
  if (!Array.isArray(env)) invalid(dir, "env must be a list");
  const names = new Set<string>();
  const variables = env.map((entry): EnvironmentVariable => {
    const variable = entry as Record<string, unknown>;
    const variableName = variable?.name;
    if (typeof variableName !== "string" || !ENVIRONMENT_VARIABLE_NAME.test(variableName)) invalid(dir, `invalid variable name ${String(variableName)}`);
    if (names.has(variableName)) invalid(dir, `${variableName} is declared twice`);
    names.add(variableName);
    if (isReservedEnvironmentVariable(variableName)) invalid(dir, `${variableName} is reserved by the platform`);
    if ("value" in variable) {
      if (typeof variable.value !== "string" || !variable.value || Object.keys(variable).length !== 2) invalid(dir, `${variableName} needs one non-empty value`);
      return { name: variableName, value: variable.value };
    }
    const ref = variable.secretRef as Record<string, unknown> | undefined;
    if (!ref || ref.source !== "platform" || typeof ref.key !== "string" || !ENVIRONMENT_VARIABLE_NAME.test(ref.key) || Object.keys(variable).length !== 2) {
      invalid(dir, `${variableName}: a built-in declares a plain value or a platform secretRef`);
    }
    return { name: variableName, secretRef: { source: "platform", key: ref.key } };
  });
  return { id, name: dir, description, baseImage: baseImage as EnvironmentBaseImage, env: variables, initScript };
}

/** Every definition under `dir` (`sandbox/environments`), by directory name. */
export async function loadBuiltInEnvironments(dir: string): Promise<BuiltInEnvironmentDefinition[]> {
  const entries = (await readdir(dir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const definitions = await Promise.all(entries.map(async (name) => parseBuiltInEnvironment(
    name,
    await readFile(join(dir, name, "environment.json"), "utf8"),
    await readFile(join(dir, name, "init.sh"), "utf8"),
  )));
  const ids = new Set<string>();
  for (const definition of definitions) {
    if (ids.has(definition.id)) invalid(definition.name, `id ${definition.id} is used twice`);
    ids.add(definition.id);
  }
  return definitions;
}

/** The variables with their fields in one order: JSONB does not keep key order. */
const canonical = (env: readonly EnvironmentVariable[]) => JSON.stringify(env.map((variable) => "secretRef" in variable
  ? { name: variable.name, secretRef: { source: variable.secretRef.source, key: variable.secretRef.key } }
  : { name: variable.name, value: variable.value }));

/**
 * What a startup did to one built-in: `retried` queued its definition again
 * because its latest build had failed.
 */
export type BuiltInChange = "created" | "rebuilt" | "retried" | "updated" | "unchanged" | "failed";

type Logger = Pick<Console, "info" | "error">;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Write the repository's built-ins (ADR-0024 "The resource"), idempotently
 * by fixed id: a new one is created pending its first build; a changed Base
 * Image or init script (its definition hash) queues a rebuild; a changed
 * name, description or variables applies without a build; an unchanged one
 * is not touched. A built-in whose latest build failed is queued once more
 * (Tenants cannot rebuild it, and an unchanged definition never builds), so
 * an operator retries it by restarting the builder. One that fails leaves
 * the others to be written.
 */
export async function syncBuiltInEnvironments(
  store: Pick<EnvironmentStore, "create" | "update" | "rebuild"> & Pick<EnvironmentBuildQueue, "getBuiltIn">,
  definitions: readonly BuiltInEnvironmentDefinition[],
  logger: Logger = console,
): Promise<Record<string, BuiltInChange>> {
  const changes: Record<string, BuiltInChange> = {};
  for (const definition of definitions) {
    let change: BuiltInChange;
    try {
      const existing = await store.getBuiltIn(definition.id);
      if (!existing) {
        await store.create({ ...definition, owner: PLATFORM, encryptedSecrets: {} });
        change = "created";
      } else {
        const update: EnvironmentStoreUpdateInput = {};
        if (existing.name !== definition.name) update.name = definition.name;
        if (existing.description !== definition.description) update.description = definition.description;
        if (canonical(existing.env) !== canonical(definition.env)) update.env = definition.env;
        if (existing.baseImage !== definition.baseImage) update.baseImage = definition.baseImage;
        if (existing.initScript !== definition.initScript) update.initScript = definition.initScript;
        change = "unchanged";
        if (Object.keys(update).length > 0) {
          if (!await store.update(PLATFORM, definition.id, update)) throw new Error("it disappeared while being updated");
          change = update.baseImage !== undefined || update.initScript !== undefined ? "rebuilt" : "updated";
        }
        if (change !== "rebuilt" && existing.lastBuild?.status === "failed") {
          if (!await store.rebuild(PLATFORM, definition.id)) throw new Error("it disappeared while being rebuilt");
          change = "retried";
        }
      }
    } catch (error) {
      logger.error(`builtin_environment ${definition.id}: ${message(error)}`);
      change = "failed";
    }
    if (change !== "unchanged") logger.info(`builtin_environment id=${definition.id} change=${change}`);
    changes[definition.id] = change;
  }
  return changes;
}

/**
 * Queue a rebuild of every Environment whose latest build finished on
 * another digest of its Base Image than the configured one (ADR-0024 "Base
 * Images"): a Base Image upgrade, such as a Pi upgrade, rebuilds every
 * Environment on it. Each is queued on its own; one that fails does not stop
 * the others, and the builds themselves succeed or fail independently.
 */
export async function rebuildOnNewBaseImages(
  store: Pick<EnvironmentStore, "rebuild"> & Pick<EnvironmentBuildQueue, "listBuiltOnOtherBaseImage">,
  baseImages: Readonly<Record<EnvironmentBaseImage, string>>,
  logger: Logger = console,
): Promise<{ queued: string[]; failed: string[] }> {
  const queued: string[] = [];
  const failed: string[] = [];
  for (const [baseImage, ref] of Object.entries(baseImages) as Array<[EnvironmentBaseImage, string]>) {
    const digest = ref.slice(ref.indexOf("@") + 1);
    for (const { id, owner } of await store.listBuiltOnOtherBaseImage(baseImage, digest)) {
      try {
        if (!await store.rebuild(owner, id)) continue;
        queued.push(id);
        logger.info(`base_image_rebuild environment=${id} base=${baseImage} digest=${digest}`);
      } catch (error) {
        failed.push(id);
        logger.error(`base_image_rebuild environment=${id}: ${message(error)}`);
      }
    }
  }
  return { queued, failed };
}
