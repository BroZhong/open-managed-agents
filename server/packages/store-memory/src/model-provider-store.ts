import type {
  ModelProviderStore,
  ModelProviderRecord,
} from "@oma-server/store";
export class InMemoryModelProviderStore implements ModelProviderStore {
  private records = new Map<string, ModelProviderRecord>();
  private key(tenantId: string, id: string) {
    return JSON.stringify([tenantId, id]);
  }
  async list(tenantId: string) {
    return structuredClone(
      [...this.records.values()].filter(
        (record) => record.tenantId === tenantId,
      ),
    );
  }
  async get(tenantId: string, id: string) {
    return structuredClone(this.records.get(this.key(tenantId, id)) ?? null);
  }
  async save(record: ModelProviderRecord) {
    this.records.set(
      this.key(record.tenantId, record.id),
      structuredClone(record),
    );
  }
  async delete(tenantId: string, id: string) {
    return this.records.delete(this.key(tenantId, id));
  }
}
