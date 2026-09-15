import { TransactionalDelegationStore, delegationFenceLost, type DelegationTransaction, type DelegationRecord, type DelegationTable } from "@oma-server/store";
import type { InMemorySessionStore } from "./session-store.js";
import type { InMemoryPendingEventStore } from "./pending-event-store.js";
import type { InMemoryEventLogStore } from "./event-log-store.js";

export class InMemoryDelegationStore extends TransactionalDelegationStore {
  private records = new Map<DelegationTable, Map<string, DelegationRecord>>();
  private queue: Promise<void> = Promise.resolve();
  private environments = new Map<string, string | null>();
  private environmentQueue: Promise<void> = Promise.resolve();
  constructor(private readonly sessions: InMemorySessionStore, private readonly pending: InMemoryPendingEventStore, private readonly events: InMemoryEventLogStore) { super(); }
  protected transaction<T>(work: (tx: DelegationTransaction) => Promise<T>): Promise<T> {
    const perform = async () => {
      const snapshot = { records: structuredClone(this.records), sessions: this.sessions.snapshotState(), pending: this.pending.snapshotState(), events: this.events.snapshotState() };
      const tx: DelegationTransaction = {
        sessions: this.sessions,
        pending: this.pending,
        read: async <R extends DelegationRecord>(table: DelegationTable, filters: Record<string, string> = {}) => [...(this.records.get(table)?.values() ?? [])].filter((record) => Object.entries(filters).every(([key, value]) => (record as unknown as Record<string, unknown>)[key] === value)).map((record) => structuredClone(record) as R),
        put: async (table, id, record) => { const values = this.records.get(table) ?? new Map(); values.set(id, structuredClone(record)); this.records.set(table, values); },
        remove: async (table, id) => { this.records.get(table)?.delete(id); },
        removePending: (sessionId, eventId, onlyUnclaimed) => this.pending.removeById(sessionId, eventId, onlyUnclaimed),
        append: (sessionId, event) => this.events.append(sessionId, event),
        assertFence: async (sessionId, fence) => { const session = await this.sessions.getById(sessionId); if (!session || session.status === "terminated" || !await this.pending.ownsClaim(sessionId, fence.eventId, fence)) delegationFenceLost(sessionId, fence); },
      };
      try { return await work(tx); }
      catch (error) { this.records = snapshot.records; this.sessions.restoreState(snapshot.sessions); this.pending.restoreState(snapshot.pending); this.events.restoreState(snapshot.events); throw error; }
    };
    const result = this.queue.then(perform, perform);
    this.queue = result.then(() => {}, () => {});
    return result;
  }
  withEnvironmentLock<T>(bindingId: string, work: (sandboxId: string | null) => Promise<{ sandboxId: string | null; value: T }>): Promise<T> {
    const perform = async () => { const result = await work(this.environments.get(bindingId) ?? null); this.environments.set(bindingId, result.sandboxId); return result.value; };
    const result = this.environmentQueue.then(perform, perform);
    this.environmentQueue = result.then(() => {}, () => {});
    return result;
  }
}
export { InMemoryDelegationStore as MemoryDelegationStore };
