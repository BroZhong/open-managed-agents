export interface TenantContext {
  tenantId: string;
  /** Present only for x-api-key authentication, never browser Bearer tokens. */
  apiKeyId?: string;
}

export interface ApiKeyStore {
  /**
   * Look up a tenant by the SHA-256 hash of an API key.
   * Returns the TenantContext if found, or null if not.
   */
  findByKeyHash(keyHash: string): Promise<TenantContext | null>;
}
