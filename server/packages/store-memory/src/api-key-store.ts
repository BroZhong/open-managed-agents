import { createHash } from "node:crypto";
import type {
  ApiKey,
  ApiKeyStore,
  ApiKeyCreateResult,
} from "@oma-server/store";

function hashKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export class InMemoryApiKeyStore implements ApiKeyStore {
  private keys: ApiKey[] = [];
  private nextId = 1;

  async create(tenantId: string, name: string): Promise<ApiKeyCreateResult> {
    const rawKey = `sk-test-${this.nextId}`;
    const apiKey: ApiKey = {
      id: `key_${this.nextId++}`,
      tenantId,
      name,
      keyHash: hashKey(rawKey),
      prefix: rawKey.slice(0, 8),
      createdAt: new Date(),
    };
    this.keys.push(apiKey);
    return { apiKey, rawKey };
  }

  async validate(rawKey: string): Promise<ApiKey | null> {
    const hash = hashKey(rawKey);
    return this.keys.find((k) => k.keyHash === hash && k.revokedAt === undefined) ?? null;
  }

  async findByKeyHash(keyHash: string): Promise<{ tenantId: string; apiKeyId: string } | null> {
    const key = this.keys.find((k) => k.keyHash === keyHash && k.revokedAt === undefined);
    return key ? { tenantId: key.tenantId, apiKeyId: key.id } : null;
  }

  async list(tenantId: string): Promise<ApiKey[]> {
    return this.keys.filter((k) => k.tenantId === tenantId);
  }

  async revoke(tenantId: string, id: string): Promise<boolean> {
    const key = this.keys.find(
      (candidate) => candidate.tenantId === tenantId && candidate.id === id && candidate.revokedAt === undefined,
    );
    if (!key) return false;
    key.revokedAt = new Date();
    return true;
  }
}
