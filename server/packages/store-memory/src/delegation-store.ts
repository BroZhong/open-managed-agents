import { TransactionalDelegationStore, delegationFenceLost, type DelegationTransaction, type DelegationRecord, type DelegationTable, type InstalledSkillSet, type WorkspaceMetadataStore } from "@oma-server/store";
import type { InMemorySessionStore } from "./session-store.js";
import type { InMemoryPendingEventStore } from "./pending-event-store.js";
import type { InMemoryEventLogStore } from "./event-log-store.js";

export class InMemoryDelegationStore extends TransactionalDelegationStore {
  private records = new Map<DelegationTable, Map<string, DelegationRecord>>();
  private queue: Promise<void> = Promise.resolve();
  private environments = new Map<string, string | null>();
  private creationPending = new Map<string, boolean>();
  private installedSkills = new Map<string, InstalledSkillSet>();
  private environmentQueue: Promise<void> = Promise.resolve();
  constructor(private readonly sessions: InMemorySessionStore, private readonly pending: InMemoryPendingEventStore, private readonly events: InMemoryEventLogStore, private readonly workspaces: Pick<WorkspaceMetadataStore, "getById">) { super(); }
  protected transaction<T>(work: (tx: DelegationTransaction) => Promise<T>): Promise<T> {
    const perform = async () => {
      // The queue serializes these transactions, as the delegation lock row
      // does in PostgreSQL, but not the other writers of the stores they
      // share: a claim taken, a lease that lapsed, an input queued, another
      // Router's events. So a failed transaction undoes exactly its own
      // writes, newest first, and whatever others committed meanwhile stays.
      // Ids and event sequence numbers are not handed out again, as
      // PostgreSQL sequences are not: another writer may have seen them.
      const undo: Array<() => void> = [];
      const records = (table: DelegationTable) => { const values = this.records.get(table) ?? new Map<string, DelegationRecord>(); this.records.set(table, values); return values; };
      const keepRecord = (table: DelegationTable, id: string) => {
        const previous = records(table).get(id);
        undo.push(() => { if (previous) records(table).set(id, previous); else records(table).delete(id); });
      };
      const tx: DelegationTransaction = {
        sessions: {
          create: async (input) => { const session = await this.sessions.create(input); undo.push(() => void this.sessions.delete(session.id)); return session; },
          getById: (id) => this.sessions.getById(id),
        },
        pending: {
          enqueue: async (sessionId, event) => { const pending = await this.pending.enqueue(sessionId, event); undo.push(() => this.pending.removeById(sessionId, pending.id)); return pending; },
          ownsClaim: (sessionId, eventId, claim) => this.pending.ownsClaim(sessionId, eventId, claim),
        },
        read: async <R extends DelegationRecord>(table: DelegationTable, filters: Record<string, string> = {}) => [...(this.records.get(table)?.values() ?? [])].filter((record) => Object.entries(filters).every(([key, value]) => (record as unknown as Record<string, unknown>)[key] === value)).map((record) => structuredClone(record) as R),
        put: async (table, id, record) => { keepRecord(table, id); records(table).set(id, structuredClone(record)); },
        remove: async (table, id) => { keepRecord(table, id); records(table).delete(id); },
        removePending: async (sessionId, eventId, onlyUnclaimed) => {
          const removed = this.pending.removeById(sessionId, eventId, onlyUnclaimed);
          if (removed) undo.push(() => this.pending.restoreRemoved(sessionId, removed));
          return Boolean(removed);
        },
        append: async (sessionId, input) => {
          const { event, added } = await this.events.appendRecorded(sessionId, input);
          if (added) undo.push(() => this.events.removeAdded(event, input.idempotencyKey));
          return event;
        },
        assertWorkspaceNotDeleted: async (tenantId, workspaceId) => {
          if ((await this.workspaces.getById(tenantId, workspaceId))?.deletedAt) throw new Error("Workspace has been deleted");
        },
        assertFence: async (sessionId, fence) => { const session = await this.sessions.getById(sessionId); if (!session || session.status === "terminated" || !await this.pending.ownsClaim(sessionId, fence.eventId, fence)) delegationFenceLost(sessionId, fence); },
      };
      try { return await work(tx); }
      catch (error) {
        for (const step of undo.reverse()) step();
        throw error;
      }
    };
    const result = this.queue.then(perform, perform);
    this.queue = result.then(() => {}, () => {});
    return result;
  }
  withEnvironmentLock<T>(bindingId: string, work: (sandboxId: string | null, creationPending?: boolean) => Promise<{ sandboxId: string | null; creationPending?: boolean; value: T }>): Promise<T> {
    const perform = async () => { const result = await work(this.environments.get(bindingId) ?? null, this.creationPending.get(bindingId) ?? false); this.environments.set(bindingId, result.sandboxId);
      if (result.creationPending !== undefined) this.creationPending.set(bindingId, result.creationPending); return result.value; };
    const result = this.environmentQueue.then(perform, perform);
    this.environmentQueue = result.then(() => {}, () => {});
    return result;
  }
  async installedSkillSet(bindingId: string): Promise<InstalledSkillSet | null> {
    const installed = this.installedSkills.get(bindingId);
    return installed ? { ...installed } : null;
  }
  async recordSkillSetInstall(bindingId: string, installed: InstalledSkillSet): Promise<boolean> {
    if ((this.environments.get(bindingId) ?? null) !== installed.sandboxId) return false;
    this.installedSkills.set(bindingId, { sandboxId: installed.sandboxId, setHash: installed.setHash });
    return true;
  }
}
export { InMemoryDelegationStore as MemoryDelegationStore };
