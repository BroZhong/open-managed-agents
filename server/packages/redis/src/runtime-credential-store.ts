import type { RedisLike } from "./redis-like.js";

const DEFAULT_TTL_MS = 30 * 60 * 1_000;
const KEY_PREFIX = "runtime-credential:pending:";

export interface RuntimeCredential {
  vfsToken: string;
  vfsEnvironment?: RuntimeVfsEnvironment;
}

export interface RuntimeVfsEnvironment {
  VFS_PROJECT_URL?: string;
  VFS_PROJECT_ID?: string;
  VFS_TEAMWORK_ID?: string;
  VFS_STORYBOARD_ID?: string;
  RUNTIME_ENV?: "test" | "prod";
}

/**
 * Host-owned, short-lived credentials for one retained input. Implementations
 * must never place these values in the Event Log, Agent config, Workspace, or
 * sandbox creation environment.
 */
export interface RuntimeCredentialStore {
  put(
    pendingEventId: string,
    credential: RuntimeCredential,
    ttlMs?: number,
  ): Promise<void>;
  get(pendingEventId: string): Promise<RuntimeCredential | null>;
  delete(pendingEventId: string): Promise<void>;
}

export class RedisRuntimeCredentialStore implements RuntimeCredentialStore {
  constructor(private readonly redis: RedisLike) {}

  async put(
    pendingEventId: string,
    credential: RuntimeCredential,
    ttlMs = DEFAULT_TTL_MS,
  ): Promise<void> {
    assertCredential(pendingEventId, credential, ttlMs);
    await this.redis.set(
      `${KEY_PREFIX}${pendingEventId}`,
      JSON.stringify(copyCredential(credential)),
      "PX",
      ttlMs,
    );
  }

  async get(pendingEventId: string): Promise<RuntimeCredential | null> {
    const raw = await this.redis.get(`${KEY_PREFIX}${pendingEventId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<RuntimeCredential>;
    if (typeof parsed.vfsToken !== "string" || !parsed.vfsToken) return null;
    const credential = {
      vfsToken: parsed.vfsToken,
      ...(parsed.vfsEnvironment
        ? { vfsEnvironment: copyEnvironment(parsed.vfsEnvironment) }
        : {}),
    };
    assertCredential(pendingEventId, credential, DEFAULT_TTL_MS);
    return credential;
  }

  async delete(pendingEventId: string): Promise<void> {
    await this.redis.del(`${KEY_PREFIX}${pendingEventId}`);
  }
}

export class InMemoryRuntimeCredentialStore implements RuntimeCredentialStore {
  private readonly credentials = new Map<
    string,
    { credential: RuntimeCredential; expiresAt: number }
  >();

  async put(
    pendingEventId: string,
    credential: RuntimeCredential,
    ttlMs = DEFAULT_TTL_MS,
  ): Promise<void> {
    assertCredential(pendingEventId, credential, ttlMs);
    this.credentials.set(pendingEventId, {
      credential: copyCredential(credential),
      expiresAt: Date.now() + ttlMs,
    });
  }

  async get(pendingEventId: string): Promise<RuntimeCredential | null> {
    const entry = this.credentials.get(pendingEventId);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.credentials.delete(pendingEventId);
      return null;
    }
    return copyCredential(entry.credential);
  }

  async delete(pendingEventId: string): Promise<void> {
    this.credentials.delete(pendingEventId);
  }
}

function assertCredential(
  pendingEventId: string,
  credential: RuntimeCredential,
  ttlMs: number,
): void {
  if (!pendingEventId) throw new RangeError("pendingEventId must not be empty");
  if (!credential.vfsToken || credential.vfsToken.includes("\0")) {
    throw new RangeError("vfsToken must be a non-empty string without NUL");
  }
  if (credential.vfsEnvironment) {
    copyEnvironment(credential.vfsEnvironment);
  }
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new RangeError("runtime credential ttlMs must be positive");
  }
}

function copyCredential(credential: RuntimeCredential): RuntimeCredential {
  return {
    vfsToken: credential.vfsToken,
    ...(credential.vfsEnvironment
      ? { vfsEnvironment: copyEnvironment(credential.vfsEnvironment) }
      : {}),
  };
}

function copyEnvironment(
  environment: RuntimeVfsEnvironment,
): RuntimeVfsEnvironment {
  const copied: RuntimeVfsEnvironment = {};
  const stringKeys = [
    "VFS_PROJECT_URL",
    "VFS_PROJECT_ID",
    "VFS_TEAMWORK_ID",
    "VFS_STORYBOARD_ID",
  ] as const;
  for (const key of stringKeys) {
    const value = environment[key];
    if (value === undefined) continue;
    if (
      typeof value !== "string" ||
      !value ||
      value.length > 4096 ||
      value.includes("\0") ||
      value.includes("\r") ||
      value.includes("\n")
    ) {
      throw new RangeError(`${key} must be a non-empty bounded single-line string`);
    }
    copied[key] = value;
  }
  if (environment.RUNTIME_ENV !== undefined) {
    if (
      environment.RUNTIME_ENV !== "test" &&
      environment.RUNTIME_ENV !== "prod"
    ) {
      throw new RangeError("RUNTIME_ENV must be test or prod");
    }
    copied.RUNTIME_ENV = environment.RUNTIME_ENV;
  }
  return copied;
}
