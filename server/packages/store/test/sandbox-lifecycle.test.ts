import { readFile } from 'node:fs/promises';
import { beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { createPgStores, PgSandboxLifecycleStore, type PgStores, type SandboxActivity } from '../src/index.js';
import { createPgTestHarness, type PgTestHarness } from './pg-harness.js';

// Real PostgreSQL is required: row locks and queue triggers are the contract.
describe.skipIf(!process.env.PG_TEST_URL)('native Sandbox execution coordination on PostgreSQL', () => {
  let harness: PgTestHarness;
  let stores: PgStores;
  let lifecycle: PgSandboxLifecycleStore;
  let activity: SandboxActivity;
  beforeEach(async () => {
    if (!harness) harness = await createPgTestHarness(); else await harness.reset();
    const schema = process.env.PG_TEST_SCHEMA ?? 'oma_test';
    if (!/^[a-z0-9_]+$/.test(schema)) throw new Error('Unsafe test schema');
    const migration = await readFile(new URL('../../../../deploy/migrations/0020_native_sandbox_lifecycle.sql', import.meta.url), 'utf8');
    await harness.pool.query(migration.replaceAll('oma.', `${schema}.`));
    stores = await createPgStores(harness.pool, { ensureSchema: false });
    lifecycle = new PgSandboxLifecycleStore(harness.pool);
    await lifecycle.assertReady();
    const agent = await stores.agentStore.create({ tenantId: 'tenant', name: 'agent', model: 'model', runtime: 'pi', system: '' });
    const session = await stores.sessionStore.create({ tenantId: 'tenant', agentId: agent.id, agent, workspaceId: 'shared' });
    activity = await begin(session.id, session.id);
    await stores.delegationStore.withEnvironmentLock(session.id, async () => ({ sandboxId: 'sandbox-original', value: undefined }));
  });
  afterAll(async () => { await harness?.close(); });
  async function begin(sessionId: string, bindingId: string, origin = 'user.message') {
    await stores.pendingEventStore.enqueue(sessionId, { type: origin, data: {}, sessionThreadId: 'sthr_primary' });
    const claim = (await stores.pendingEventStore.claim(sessionId, 'host', 60000))!;
    const use = { sessionId, bindingId, fence: { eventId: claim.event.id, ownerId: claim.ownerId, generation: claim.generation } };
    await lifecycle.begin(use); return use;
  }
  const ack = (use = activity) => stores.pendingEventStore.ack(use.sessionId, use.fence.eventId, use.fence);
  const id = () => stores.delegationStore.withEnvironmentLock(activity.bindingId, async id => ({ sandboxId: id, value: id }));

  it('sets idle only after actual settlement and an empty queue, without a clock or scanner', async () => {
    const idle = vi.fn(async () => {});
    await ack();
    // Missing callbacks retain the existing finite platform deadline.
    expect(idle).not.toHaveBeenCalled();
    await lifecycle.finish(activity, idle);
    expect(idle).toHaveBeenCalledExactlyOnceWith('sandbox-original');
    await lifecycle.finish(activity, idle);
    expect(idle).toHaveBeenCalledTimes(1);
  });
  it.each(['user.message', 'delegation_input', 'delegation_result'])('protects queued %s input', async origin => {
    const idle = vi.fn(async () => {});
    await stores.pendingEventStore.enqueue(activity.sessionId, { type: origin, data: {}, sessionThreadId: 'sthr_primary' });
    await ack(); await lifecycle.finish(activity, idle);
    expect(idle).not.toHaveBeenCalled();
    expect(await lifecycle.claimReclamation(activity.bindingId)).toBeNull();
  });
  it('waits for a child sharing the binding but not an independent Session sharing only Workspace', async () => {
    const parent = (await stores.sessionStore.getById(activity.sessionId))!;
    const child = await stores.sessionStore.create({ tenantId: parent.tenantId, agentId: parent.agentId, agent: parent.agent, workspaceId: parent.workspaceId,
      delegation: { parentSessionId: parent.id, parentTurnId: 'turn', parentToolUseId: 'tool', sandboxSessionId: parent.id } });
    const childUse = await begin(child.id, parent.id, 'delegation_input');
    const independent = await stores.sessionStore.create({ tenantId: parent.tenantId, agentId: parent.agentId, agent: parent.agent, workspaceId: parent.workspaceId });
    await begin(independent.id, independent.id);
    const idle = vi.fn(async () => {});
    await ack(); await lifecycle.finish(activity, idle);
    expect(idle).not.toHaveBeenCalled();
    await ack(childUse); await lifecycle.finish(childUse, idle);
    expect(idle).toHaveBeenCalledExactlyOnceWith('sandbox-original');
  });
  it('does not turn lease loss into idle and supersedes uncertainty only on new admission', async () => {
    const idle = vi.fn(async () => {});
    await stores.pendingEventStore.releaseClaim(activity.sessionId, activity.fence.eventId, activity.fence);
    expect(idle).not.toHaveBeenCalled();
    const claim = (await stores.pendingEventStore.claim(activity.sessionId, 'next-runner', 60000))!;
    const newer = { ...activity, fence: { eventId: claim.event.id, ownerId: claim.ownerId, generation: claim.generation } };
    await lifecycle.begin(newer);
    await lifecycle.finish(activity, idle); // Old generation cannot release the new owner.
    expect(idle).not.toHaveBeenCalled();
    await ack(newer); await lifecycle.finish(newer, idle);
    expect(idle).toHaveBeenCalledTimes(1);
  });
  it('serializes new input with the idle request, without claiming remote fencing', async () => {
    await ack();
    let arrived!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => { arrived = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const finish = lifecycle.finish(activity, async () => { arrived(); await gate; });
    await entered;
    let accepted = false;
    const enqueue = stores.pendingEventStore.enqueue(activity.sessionId, { type: 'user.message', data: {}, sessionThreadId: 'sthr_primary' }).then(() => { accepted = true; });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(accepted).toBe(false);
    release(); await finish; await enqueue;
    expect(accepted).toBe(true);
    expect(await lifecycle.claimReclamation(activity.bindingId)).toBeNull();
  });
  it('retains failed idle settlement for retry and cannot let an old retry shorten a newer generation', async () => {
    await ack();
    await expect(lifecycle.finish(activity, async () => { throw new Error('timeout response lost'); })).rejects.toThrow('response lost');
    const newer = await begin(activity.sessionId, activity.bindingId);
    const idle = vi.fn(async () => {});
    await lifecycle.finish(activity, idle);
    expect(idle).not.toHaveBeenCalled();
    await ack(newer); await lifecycle.finish(newer, idle);
    expect(idle).toHaveBeenCalledTimes(1);
  });
  it('retries committed explicit deletion across Runners and rejects stale cleanup callbacks', async () => {
    expect(await lifecycle.claimReclamation(activity.bindingId)).toBeNull();
    await stores.sessionStore.terminate(activity.sessionId);
    const ticket = (await lifecycle.claimReclamation(activity.bindingId))!;
    expect(ticket.sandboxId).toBe('sandbox-original');
    const restarted = new PgSandboxLifecycleStore(harness.pool);
    expect(await restarted.claimReclamation(activity.bindingId)).toEqual(ticket);
    await expect(id()).rejects.toThrow('reclamation');
    await restarted.completeReclamation(ticket);
    expect(await id()).toBeNull();
    await stores.delegationStore.withEnvironmentLock(activity.bindingId, async () => ({ sandboxId: 'replacement', value: undefined }));
    await lifecycle.completeReclamation(ticket);
    expect(await id()).toBe('replacement');
  });
  it('durably preserves an ambiguous creation intent across Runner restart', async () => {
    await stores.delegationStore.withEnvironmentLock(activity.bindingId, async () => ({ sandboxId: null, creationPending: true, value: undefined }));
    const restarted = await createPgStores(harness.pool, { ensureSchema: false });
    const state = await restarted.delegationStore.withEnvironmentLock(activity.bindingId, async (sandboxId, pending) => ({ sandboxId, value: { sandboxId, pending } }));
    expect(state).toEqual({ sandboxId: null, pending: true });
  });
});
