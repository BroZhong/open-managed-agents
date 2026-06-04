export interface TenantContext {
  tenantId: string;
}

export interface ApiKeyStore {
  /**
   * Look up a tenant by the SHA-256 hash of an API key.
   * Returns the TenantContext if found, or null if not.
   */
  findByKeyHash(keyHash: string): Promise<TenantContext | null>;
}
