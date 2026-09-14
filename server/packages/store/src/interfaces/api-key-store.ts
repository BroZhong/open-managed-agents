import type { ApiKey } from "../types.js";

export interface ApiKeyCreateResult {
  apiKey: ApiKey;
  rawKey: string;
}

export interface ApiKeyStore {
  create(tenantId: string, name: string): Promise<ApiKeyCreateResult>;
  validate(rawKey: string): Promise<ApiKey | null>;
  list(tenantId: string): Promise<ApiKey[]>;
  revoke(tenantId: string, id: string): Promise<boolean>;
}
