import { randomBytes } from "node:crypto";
import type { SessionShare, SessionShareStore } from "@oma-server/store";

export class InMemorySessionShareStore implements SessionShareStore {
  private readonly shares = new Map<string, SessionShare>();
  async getById(id: string): Promise<SessionShare | null> {
    return [...this.shares.values()].find((share) => share.id === id) ?? null;
  }
  async getOrCreate(sessionId: string): Promise<SessionShare> {
    let share = this.shares.get(sessionId);
    if (!share) {
      share = { id: randomBytes(32).toString("base64url"), sessionId };
      this.shares.set(sessionId, share);
    }
    return share;
  }
}
