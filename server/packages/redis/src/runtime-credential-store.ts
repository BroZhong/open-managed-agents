import type { RedisLike } from "./redis-like.js";

const DEFAULT_TTL_MS = 30 * 60 * 1_000;
const KEY_PREFIX = "runtime-credential:pending:";

export interface RuntimeCredential {
  vfsToken: string;
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
      JSON.stringify(credential),
      "PX",
      ttlMs,
    );
  }

  async get(pendingEventId: string): Promise<RuntimeCredential | null> {
    const raw = await this.redis.get(`${KEY_PREFIX}${pendingEventId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<RuntimeCredential>;
    return typeof parsed.vfsToken === "string" && parsed.vfsToken
      ? { vfsToken: parsed.vfsToken }
      : null;
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
      credential: { ...credential },
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
    return { ...entry.credential };
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
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new RangeError("runtime credential ttlMs must be positive");
  }
}
