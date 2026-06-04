import { createHash } from "node:crypto";
import type { Collection, Db } from "mongodb";
import { nanoid } from "nanoid";
import type { ApiKeyCreateResult, ApiKeyStore } from "../interfaces/api-key-store.js";
import type { ApiKey } from "../types.js";

interface ApiKeyDoc {
  _id: string;
  tenantId: string;
  name: string;
  keyHash: string;
  prefix: string;
  createdAt: Date;
}

function docToApiKey(doc: ApiKeyDoc): ApiKey {
  return {
    id: doc._id,
    tenantId: doc.tenantId,
    name: doc.name,
    keyHash: doc.keyHash,
    prefix: doc.prefix,
    createdAt: doc.createdAt,
  };
}

function hashKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export class MongoApiKeyStore implements ApiKeyStore {
  private collection: Collection<ApiKeyDoc>;

  constructor(db: Db) {
    this.collection = db.collection<ApiKeyDoc>("api_keys");
  }

  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex({ keyHash: 1 }, { unique: true });
  }

  async create(tenantId: string, name: string): Promise<ApiKeyCreateResult> {
    const rawKey = `omak_${nanoid(32)}`;
    const prefix = rawKey.slice(0, 9);
    const now = new Date();

    const doc: ApiKeyDoc = {
      _id: `apikey_${nanoid()}`,
      tenantId,
      name,
      keyHash: hashKey(rawKey),
      prefix,
      createdAt: now,
    };

    await this.collection.insertOne(doc);
    return { apiKey: docToApiKey(doc), rawKey };
  }

  async validate(rawKey: string): Promise<ApiKey | null> {
    const hash = hashKey(rawKey);
    const doc = await this.collection.findOne({ keyHash: hash });
    return doc ? docToApiKey(doc) : null;
  }

  async list(tenantId: string): Promise<ApiKey[]> {
    const docs = await this.collection.find({ tenantId }).toArray();
    return docs.map(docToApiKey);
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.collection.deleteOne({ _id: id });
    return result.deletedCount === 1;
  }
}
