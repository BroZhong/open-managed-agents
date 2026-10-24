import { TransactionalDelegationStore, delegationFenceLost, type DelegationTransaction, type DelegationRecord, type DelegationTable, type EnvironmentBinding, type EnvironmentLockResult, type EnvironmentRecord, type InstalledSkillSet, type SkillSetRecordOutcome, type WorkspaceMetadataStore } from "@oma-server/store";
import type { InMemorySessionStore } from "./session-store.js";
import type { InMemoryPendingEventStore } from "./pending-event-store.js";
import type { InMemoryEventLogStore } from "./event-log-store.js";

export class InMemoryDelegationStore extends TransactionalDelegationStore {
  private records = new Map<DelegationTable, Map<string, DelegationRecord>>();
  private queue: Promise<void> = Promise.resolve();
  /** Environment binding rows; an absent one is Cold. */
  private environments = new Map<string, EnvironmentRecord>();
  private installedSkills = new Map<string, InstalledSkillSet>();
  private environmentQueues = new Map<string, Promise<void>>();
  constructor(private readonly sessions: InMemorySessionStore, private readonly pending: InMemoryPendingEventStore, private readonly events: InMemoryEventLogStore, private readonly workspaces: Pick<WorkspaceMetadataStore, "getById">,
    /** Stands in for PostgreSQL's now(): the clock binding intents are written and judged with. */
    private readonly databaseClock: () => Date = () => new Date()) { super(); }
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
  /**
   * Serialized per binding, as one PostgreSQL store's callers are; with one
   * writer per row the compare-and-set always applies. Bindings do not wait
   * for each other, so a Runner a test loses inside one stalls no other.
   */
  withEnvironmentLock<T>(bindingId: string, work: (binding: EnvironmentBinding) => Promise<EnvironmentLockResult<T>>): Promise<T> {
    const perform = async () => {
      let row = this.environments.get(bindingId) ?? { sandboxId: null, creatingSince: null, stateSince: null, lastError: null };
      const { value, next, observed } = await work({ sandboxId: row.sandboxId, creatingSince: row.creatingSince, now: this.databaseClock() });
      const now = this.databaseClock();
      // As PgDelegationStore writes them: a move begins a new state, a first
      // failure begins unavailability, a ready observation ends it.
      if (next) row = { sandboxId: typeof next === "object" ? next.ready : null, creatingSince: next === "creating" ? now : null, stateSince: now, lastError: null };
      if (observed === "ready") { if (row.lastError) row = { ...row, stateSince: now, lastError: null }; }
      else if (observed) row = { ...row, stateSince: row.lastError ? row.stateSince : now, lastError: { ...observed.failure, at: now } };
      if (next || observed) this.environments.set(bindingId, row);
      return value;
    };
    const previous = this.environmentQueues.get(bindingId) ?? Promise.resolve();
    const result = previous.then(perform, perform);
    const settled = result.then(() => {}, () => {});
    this.environmentQueues.set(bindingId, settled);
    void settled.then(() => { if (this.environmentQueues.get(bindingId) === settled) this.environmentQueues.delete(bindingId); });
    return result;
  }
  protected async environmentRecord(bindingId: string): Promise<EnvironmentRecord | undefined> {
    const row = this.environments.get(bindingId);
    return row && structuredClone(row);
  }
  async installedSkillSet(bindingId: string): Promise<InstalledSkillSet | null> {
    const installed = this.installedSkills.get(bindingId);
    return installed ? { ...installed } : null;
  }
  async recordSkillSetInstall(bindingId: string, installed: InstalledSkillSet): Promise<SkillSetRecordOutcome> {
    if ((this.environments.get(bindingId)?.sandboxId ?? null) !== installed.sandboxId) return "detached";
    const recorded = this.installedSkills.get(bindingId);
    if (recorded?.sandboxId === installed.sandboxId && recorded.generation >= installed.generation) return "superseded";
    this.installedSkills.set(bindingId, { sandboxId: installed.sandboxId, setHash: installed.setHash, generation: installed.generation });
    return "recorded";
  }
}
export { InMemoryDelegationStore as MemoryDelegationStore };
