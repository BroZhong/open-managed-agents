export interface ModelProviderRecord {
  id: string;
  tenantId: string;
  name: string;
  api: "openai-completions" | "openai-responses" | "anthropic-messages";
  baseUrl: string;
  encryptedApiKey: string;
  models: {
    id: string;
    name: string;
    contextWindow: number;
    maxTokens: number;
    reasoning: boolean;
    input: ("text" | "image")[];
    catalogProvider?: string;
  }[];
  testedAt: string;
}
export interface ModelProviderStore {
  list(tenantId: string): Promise<ModelProviderRecord[]>;
  get(tenantId: string, id: string): Promise<ModelProviderRecord | null>;
  save(record: ModelProviderRecord): Promise<void>;
  delete(tenantId: string, id: string): Promise<boolean>;
}
