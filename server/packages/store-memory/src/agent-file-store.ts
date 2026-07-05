import type {
  AgentFile,
  AgentFileStore,
  AgentFileSummary,
} from "@oma-server/store";

interface StoredAgentFile {
  tenantId: string;
  agentId: string;
  filename: string;
  content: string;
  updatedAt: Date;
}

export class InMemoryAgentFileStore implements AgentFileStore {
  private files: StoredAgentFile[] = [];

  async list(tenantId: string, agentId: string): Promise<AgentFileSummary[]> {
    return this.files
      .filter((f) => f.tenantId === tenantId && f.agentId === agentId)
      .sort((a, b) => a.filename.localeCompare(b.filename))
      .map((f) => ({ filename: f.filename, updatedAt: f.updatedAt }));
  }

  async get(
    tenantId: string,
    agentId: string,
    filename: string,
  ): Promise<AgentFile | null> {
    const f = this.find(tenantId, agentId, filename);
    return f
      ? { filename: f.filename, content: f.content, updatedAt: f.updatedAt }
      : null;
  }

  async upsert(
    tenantId: string,
    agentId: string,
    filename: string,
    content: string,
  ): Promise<AgentFile> {
    const now = new Date();
    const existing = this.find(tenantId, agentId, filename);
    if (existing) {
      existing.content = content;
      existing.updatedAt = now;
      return { filename, content, updatedAt: now };
    }
    this.files.push({ tenantId, agentId, filename, content, updatedAt: now });
    return { filename, content, updatedAt: now };
  }

  async delete(
    tenantId: string,
    agentId: string,
    filename: string,
  ): Promise<boolean> {
    const idx = this.files.findIndex(
      (f) =>
        f.tenantId === tenantId &&
        f.agentId === agentId &&
        f.filename === filename,
    );
    if (idx < 0) return false;
    this.files.splice(idx, 1);
    return true;
  }

  private find(
    tenantId: string,
    agentId: string,
    filename: string,
  ): StoredAgentFile | undefined {
    return this.files.find(
      (f) =>
        f.tenantId === tenantId &&
        f.agentId === agentId &&
        f.filename === filename,
    );
  }
}
