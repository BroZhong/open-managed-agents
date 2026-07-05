/**
 * An Agent File: a small editable markdown document (IDENTITY, SOUL, USER,
 * MEMORY) that shapes an Agent's identity/instructions. Files are isolated per
 * tenant + Agent. They are part of the Agent's persona, never a Session's
 * Workspace — Agent Files never touch a Session's Workspace/S3.
 */
export interface AgentFile {
  filename: string;
  content: string;
  updatedAt: Date;
}

/** List entry: omits content (list returns metadata only). */
export interface AgentFileSummary {
  filename: string;
  updatedAt: Date;
}

export interface AgentFileStore {
  /** List an Agent's Files (metadata only, no content), tenant+agent scoped. */
  list(tenantId: string, agentId: string): Promise<AgentFileSummary[]>;
  /** Read one File's full content, or null if absent. */
  get(tenantId: string, agentId: string, filename: string): Promise<AgentFile | null>;
  /** Create or overwrite a File's content, returning the stored File. */
  upsert(tenantId: string, agentId: string, filename: string, content: string): Promise<AgentFile>;
  /** Delete a File. Returns true if a File was removed. */
  delete(tenantId: string, agentId: string, filename: string): Promise<boolean>;
}
