import { HTTPException } from "hono/http-exception";
import {
  EnvironmentNameConflictError,
  newEnvironmentId,
  type SandboxEnvironmentRecord,
  type Environment,
  type EnvironmentBaseImage,
  type EnvironmentOwner,
  type EnvironmentStore,
  type EnvironmentStoreUpdateInput,
  type EnvironmentVariable,
  type Session,
} from "@oma-server/store";
import { ENVIRONMENT_VARIABLE_NAME, isReservedEnvironmentVariable, type SandboxEnvironments } from "@oma-server/sandbox";
import { SecretBox, sealedPlaintextBytes } from "./secret-box.js";
import { publicSession } from "./public-projection.js";

/** Bytes, not characters: the limits bound what the builder and Sandboxes receive. */
export const ENVIRONMENT_ENV_MAX_BYTES = 32 * 1024;
export const ENVIRONMENT_INIT_SCRIPT_MAX_BYTES = 256 * 1024;

/** A variable as written: a Tenant secret reference may carry the secret's new value. */
export type EnvironmentVariableInput =
  | { name: string; value: string }
  | { name: string; secretRef: { source: "platform" | "environment"; key: string }; value?: string };

export interface EnvironmentInput {
  name?: string;
  description?: string;
  baseImage?: EnvironmentBaseImage;
  initScript?: string;
  env?: EnvironmentVariableInput[];
}

/** Create a Tenant Environment, or copy the visible Environment `from`. */
export interface EnvironmentCreateInput extends EnvironmentInput {
  from?: string;
}

/**
 * Whether an Agent references the Environment. Deleting one that is in use
 * answers 409 `environment_in_use`.
 */
export type EnvironmentInUse = (tenantId: string, environmentId: string) => Promise<boolean>;

/** A Session's Environment as the Session API shows it (ADR-0024): its id and current name. */
export interface SessionEnvironment {
  id: string;
  name: string;
}

/**
 * Sessions as the Session API returns them, each with its Environment
 * (ADR-0024). A Host that serves no Environments shows a frozen id as its name.
 */
export async function publicSessions(tenantId: string, sessions: readonly Session[], environments?: Pick<EnvironmentService, "ofSessions">) {
  const shown = environments
    ? await environments.ofSessions(tenantId, sessions)
    : sessions.map(({ environmentId: id }) => (id ? { id, name: id } : null));
  return sessions.map((session, index) => publicSession(session, shown[index] ?? null));
}

export class EnvironmentError extends HTTPException {
  constructor(status: 400 | 403 | 404 | 409 | 503, readonly code: string, message: string) {
    super(status, { res: Response.json({ error: message, code }, { status }) });
  }
}

const notFound = () => new EnvironmentError(404, "environment_not_found", "Environment not found");
const invalid = (code: string, message: string) => new EnvironmentError(400, code, message);
const NAME_MAX = 100;
const bytes = (value: string) => Buffer.byteLength(value, "utf8");

/**
 * The authenticated data a Tenant secret is sealed with: it opens only on
 * the Environment and under the key it was written to. The Host decrypts it
 * with the same `SecretBox` key (`OMA_PROVIDER_ENCRYPTION_KEY`).
 */
export function environmentSecretScope(env: Pick<Environment, "id" | "tenantId">, key: string): string {
  return `environment:${env.tenantId ?? "platform"}:${env.id}:${key}`;
}

/**
 * The Environments Sessions run in, as a Runner resolves them for their
 * Sandboxes (ADR-0024, "Starting a Sandbox"). Each call reads the
 * Environment as it is now, by primary key: an edit made on an API pod
 * reaches every Runner's next command. Variables are resolved only here, at
 * injection: Tenant secrets opened with the key they were sealed under,
 * platform secret references from the deployment's platform values (the
 * base Secret the Runner loads at startup). A reference the deployment does
 * not provide is left out, and reported once by name.
 */
export class SandboxEnvironmentResolver implements SandboxEnvironments {
  private readonly secrets: SecretBox;
  private readonly reported = new Set<string>();

  constructor(
    private readonly store: Pick<EnvironmentStore, "getForSandbox">,
    encryptionKey: string | undefined,
    private readonly platformSecrets: Readonly<Record<string, string>>,
    private readonly logger: Pick<Console, "warn"> = console,
  ) {
    this.secrets = new SecretBox(encryptionKey, () => new Error("Environment secrets require OMA_PROVIDER_ENCRYPTION_KEY (32 bytes encoded as hex)."));
  }

  async image(tenantId: string, environmentId: string): Promise<string | null> {
    return (await this.store.getForSandbox(tenantId, environmentId))?.image ?? null;
  }

  async variables(tenantId: string, environmentId: string): Promise<Record<string, string>> {
    const env = await this.store.getForSandbox(tenantId, environmentId);
    return env ? this.resolve(env) : {};
  }

  private resolve(env: SandboxEnvironmentRecord): Record<string, string> {
    const resolved: Record<string, string> = {};
    for (const variable of env.env) {
      if (!("secretRef" in variable)) { resolved[variable.name] = variable.value; continue; }
      const { source, key } = variable.secretRef;
      if (source === "platform") {
        if (Object.hasOwn(this.platformSecrets, key)) resolved[variable.name] = this.platformSecrets[key]!;
        else this.report(env.id, `${variable.name} refers to platform secret ${key}, which this deployment does not provide`);
        continue;
      }
      const sealed = env.encryptedSecrets[key];
      if (sealed === undefined) { this.report(env.id, `${variable.name} refers to secret ${key}, which is not stored`); continue; }
      resolved[variable.name] = this.secrets.open(sealed, environmentSecretScope(env, key));
    }
    return resolved;
  }

  /** Names only, once per Environment and variable: commands run without it. */
  private report(environmentId: string, problem: string): void {
    const key = `${environmentId}:${problem}`;
    if (this.reported.has(key)) return;
    this.reported.add(key);
    this.logger.warn(`Environment ${environmentId}: ${problem}; its commands run without it.`);
  }
}

/** The API view of an Environment: no Tenant id, no secret ciphertexts. */
export function publicEnvironment(env: Environment) {
  const { tenantId: _tenant, encryptedSecrets: _secrets, ...rest } = env;
  return rest;
}

/** The list view: without the script, variables and manifest. */
export function environmentSummary(env: Environment) {
  const { initScript: _script, env: _env, manifest: _manifest, ...rest } = publicEnvironment(env);
  return rest;
}

/**
 * Environments (ADR-0024) as a Tenant creates, copies, edits and deletes
 * them. The store queues the build in the same transaction as each change;
 * nothing here executes.
 */
export class EnvironmentService {
  private readonly secrets: SecretBox;

  constructor(
    readonly store: EnvironmentStore,
    encryptionKey: string | undefined,
    private readonly options: { inUse?: EnvironmentInUse } = {},
  ) {
    this.secrets = new SecretBox(encryptionKey, () => new EnvironmentError(503, "environment_secrets_unavailable",
      "Environment secrets require OMA_PROVIDER_ENCRYPTION_KEY (32 bytes encoded as hex)."));
  }

  async list(tenantId: string) {
    return (await this.store.list(tenantId)).map(environmentSummary);
  }

  async get(tenantId: string, id: string) {
    return publicEnvironment(await this.visible(tenantId, id));
  }

  /**
   * The Environment an Agent is bound to or a Session created in (ADR-0024):
   * one the Tenant can see (404 `environment_not_found`) that is ready (409
   * `environment_not_ready`).
   */
  async ready(tenantId: string, id: string): Promise<Environment> {
    const env = await this.visible(tenantId, id);
    if (env.status !== "ready") {
      throw new EnvironmentError(409, "environment_not_ready",
        `Environment ${env.name} is ${env.status}; only a ready Environment can be bound to an Agent or chosen for a Session.`);
    }
    return env;
  }

  /**
   * Each Session's Environment as the Session API shows it, deleted or not;
   * null for a Session without one. One read for all of them.
   */
  async ofSessions(tenantId: string, sessions: readonly Pick<Session, "environmentId">[]): Promise<Array<SessionEnvironment | null>> {
    const ids = sessions.flatMap((session) => (session.environmentId ? [session.environmentId] : []));
    const names = new Map((await this.store.listForSessions(tenantId, ids)).map((env) => [env.id, env.name]));
    return sessions.map(({ environmentId: id }) => (id ? { id, name: names.get(id) ?? id } : null));
  }

  async create(tenantId: string, input: EnvironmentCreateInput) {
    const source = input.from === undefined ? undefined : await this.visible(tenantId, input.from);
    const name = input.name ?? (source ? await this.copyName(tenantId, source.name) : undefined);
    const baseImage = input.baseImage ?? source?.baseImage;
    if (name === undefined) throw invalid("validation_error", "name is required");
    if (baseImage === undefined) throw invalid("validation_error", "baseImage is required");
    const initScript = input.initScript ?? source?.initScript ?? "";
    assertScript(initScript);
    const target = { id: newEnvironmentId(), tenantId };
    const variables = input.env !== undefined
      ? this.resolve(target, input.env, source)
      : source ? this.carry(target, source) : { env: [], encryptedSecrets: {} };
    try {
      return publicEnvironment(await this.store.create({
        id: target.id,
        owner: { ownerType: "tenant", tenantId },
        name,
        description: input.description ?? source?.description ?? "",
        baseImage,
        initScript,
        ...variables,
      }));
    } catch (error) {
      throw conflict(error);
    }
  }

  async update(tenantId: string, id: string, input: EnvironmentInput) {
    const existing = await this.owned(tenantId, id);
    if (input.initScript !== undefined) assertScript(input.initScript);
    const update: EnvironmentStoreUpdateInput = {
      name: input.name,
      description: input.description,
      baseImage: input.baseImage,
      initScript: input.initScript,
      ...(input.env !== undefined ? this.resolve(existing, input.env, existing) : {}),
    };
    try {
      const updated = await this.store.update({ ownerType: "tenant", tenantId }, id, update);
      if (!updated) throw notFound();
      return publicEnvironment(updated);
    } catch (error) {
      throw conflict(error);
    }
  }

  async delete(tenantId: string, id: string) {
    await this.owned(tenantId, id);
    if (await this.options.inUse?.(tenantId, id)) {
      throw new EnvironmentError(409, "environment_in_use", "An Agent uses this Environment; bind the Agent to another Environment first.");
    }
    if (!await this.store.delete({ ownerType: "tenant", tenantId }, id)) throw notFound();
    return { type: "environment_deleted", id };
  }

  private async visible(tenantId: string, id: string): Promise<Environment> {
    const env = await this.store.get(tenantId, id);
    if (!env) throw notFound();
    return env;
  }

  /** The Tenant's own Environment; a built-in is read-only. */
  private async owned(tenantId: string, id: string): Promise<Environment> {
    const env = await this.visible(tenantId, id);
    if (env.ownerType === "platform") {
      throw new EnvironmentError(403, "environment_read_only", "Built-in Environments are read-only; copy it to customize it.");
    }
    return env;
  }

  /** "<name>-copy", then "<name>-copy-2", … : the first the Tenant does not use. */
  private async copyName(tenantId: string, name: string): Promise<string> {
    const taken = new Set((await this.store.list(tenantId)).filter((env) => env.ownerType === "tenant").map((env) => env.name));
    for (let n = 1; ; n++) {
      const suffix = n === 1 ? "-copy" : `-copy-${n}`;
      const candidate = name.slice(0, NAME_MAX - suffix.length) + suffix;
      if (!taken.has(candidate)) return candidate;
    }
  }

  /** A copy's variables when the request names none: the source's, its secrets sealed for the copy. */
  private carry(target: Pick<Environment, "id" | "tenantId">, source: Environment) {
    const encryptedSecrets: Record<string, string> = {};
    for (const [key, sealed] of Object.entries(source.encryptedSecrets)) {
      encryptedSecrets[key] = this.secrets.seal(this.secrets.open(sealed, environmentSecretScope(source, key)), environmentSecretScope(target, key));
    }
    return { env: structuredClone(source.env), encryptedSecrets };
  }

  /**
   * Validate a complete variable set for `target` and seal its Tenant
   * secrets. `base` is what the set replaces (or the copy source): a platform
   * secret reference is accepted only as `base` already carries it, and a
   * Tenant secret sent without a value keeps the one `base` stores.
   */
  private resolve(target: Pick<Environment, "id" | "tenantId">, input: EnvironmentVariableInput[], base: Environment | undefined) {
    const env: EnvironmentVariable[] = [];
    const values = new Map<string, string>();
    const names = new Set<string>();
    let total = 0;
    for (const variable of input) {
      const { name } = variable;
      if (!ENVIRONMENT_VARIABLE_NAME.test(name)) throw invalid("environment_env_invalid", `${name} is not a valid variable name`);
      if (names.has(name)) throw invalid("environment_env_invalid", `${name} is set more than once`);
      names.add(name);
      if (isReservedEnvironmentVariable(name)) {
        throw invalid("environment_env_reserved", `${name} is reserved by the platform and cannot be set by an Environment`);
      }
      if (!("secretRef" in variable)) {
        if (!variable.value) throw invalid("environment_env_empty_value", `${name} needs a value`);
        total += bytes(variable.value);
        env.push({ name, value: variable.value });
        continue;
      }
      const { source, key } = variable.secretRef;
      if (!ENVIRONMENT_VARIABLE_NAME.test(key)) throw invalid("environment_env_invalid", `${key} is not a valid secret key`);
      if (source === "platform") {
        if (variable.value !== undefined) throw invalid("environment_env_invalid", `${name} refers to a platform secret and takes no value`);
        if (!base?.env.some((carried) => carried.name === name && "secretRef" in carried && carried.secretRef.source === "platform" && carried.secretRef.key === key)) {
          throw invalid("environment_secret_ref_forbidden", `${name}: platform secrets are only available by copying a Built-in Environment that provides them`);
        }
      } else if (variable.value !== undefined) {
        if (!variable.value) throw invalid("environment_env_empty_value", `${name} needs a value`);
        if ((values.get(key) ?? variable.value) !== variable.value) throw invalid("environment_env_invalid", `Secret ${key} is given two different values`);
        values.set(key, variable.value);
      }
      env.push({ name, secretRef: { source, key } });
    }
    // Seal each referenced Tenant secret once: a new value, or the one base stores.
    const encryptedSecrets: Record<string, string> = {};
    for (const variable of env) {
      if (!("secretRef" in variable) || variable.secretRef.source !== "environment" || variable.secretRef.key in encryptedSecrets) continue;
      const { key } = variable.secretRef;
      const value = values.get(key);
      if (value !== undefined) {
        total += bytes(value);
        encryptedSecrets[key] = this.secrets.seal(value, environmentSecretScope(target, key));
        continue;
      }
      const kept = base?.encryptedSecrets[key];
      if (base === undefined || kept === undefined) throw invalid("environment_secret_missing", `${variable.name}: secret ${key} has no stored value; send one`);
      total += sealedPlaintextBytes(kept);
      encryptedSecrets[key] = base.id === target.id
        ? kept
        : this.secrets.seal(this.secrets.open(kept, environmentSecretScope(base, key)), environmentSecretScope(target, key));
    }
    if (total > ENVIRONMENT_ENV_MAX_BYTES) {
      throw invalid("environment_env_too_large", `Variable values total ${total} bytes; the limit is ${ENVIRONMENT_ENV_MAX_BYTES} (32 KiB)`);
    }
    return { env, encryptedSecrets };
  }
}

function assertScript(initScript: string): void {
  const size = bytes(initScript);
  if (size > ENVIRONMENT_INIT_SCRIPT_MAX_BYTES) {
    throw invalid("environment_init_script_too_large", `initScript is ${size} bytes; the limit is ${ENVIRONMENT_INIT_SCRIPT_MAX_BYTES} (256 KiB)`);
  }
}

function conflict(error: unknown): unknown {
  return error instanceof EnvironmentNameConflictError
    ? new EnvironmentError(409, "environment_name_conflict", error.message)
    : error;
}
