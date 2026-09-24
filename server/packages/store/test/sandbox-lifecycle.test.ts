import { readFile } from 'node:fs/promises';
import { beforeEach, afterAll, describe, expect, it } from 'vitest';
import { createPgStores, PgSandboxLifecycleStore, type PgStores, type SandboxActivity } from '../src/index.js';
import { createPgTestHarness, type PgTestHarness } from './pg-harness.js';

// Requires real row locks and triggers; pg-mem is not concurrency evidence.
describe.skipIf(!process.env.PG_TEST_URL)('durable Sandbox lifecycle on PostgreSQL', () => {
  let harness: PgTestHarness;
  let stores: PgStores;
  let lifecycle: PgSandboxLifecycleStore;
  let activity: SandboxActivity;
  let nowMs: number;
  const clock = () => new Date(nowMs);
  beforeEach(async () => {
    if (!harness) harness = await createPgTestHarness(); else await harness.reset();
    const schema = process.env.PG_TEST_SCHEMA ?? 'oma_test';
    if (!/^[a-z0-9_]+$/.test(schema)) throw new Error('Unsafe test schema');
    const migration = await readFile(new URL('../../../../deploy/migrations/0014_sandbox_lifecycle.sql', import.meta.url), 'utf8');
    await harness.pool.query(migration.replaceAll('oma.', `${schema}.`));
    stores = await createPgStores(harness.pool, { ensureSchema: false });
    nowMs = Date.now();
    lifecycle = new PgSandboxLifecycleStore(harness.pool, clock);
    await lifecycle.assertReady();
    const agent = await stores.agentStore.create({ tenantId: 'tenant', name: 'agent', model: 'model', runtime: 'pi', system: '' });
    const session = await stores.sessionStore.create({ tenantId: 'tenant', agentId: agent.id, agent, workspaceId: 'shared' });
    await stores.pendingEventStore.enqueue(session.id, { type: 'user.message', data: {}, sessionThreadId: 'sthr_primary' });
    const claim = (await stores.pendingEventStore.claim(session.id, 'host-one', 3600000))!;
    activity = { bindingId: session.id, sessionId: session.id, fence: { eventId: claim.event.id, ownerId: claim.ownerId, generation: claim.generation } };
    await lifecycle.begin(activity);
    await stores.delegationStore.withEnvironmentLock(session.id, async () => ({ sandboxId: 'sandbox-original', value: undefined }));
  });
  afterAll(async () => { await harness?.close(); });
  const ageIdle = async (minutes: number) => {
    await harness.pool.query('UPDATE delegation_environments SET idle_since = $2 WHERE id = $1', [activity.bindingId, new Date(nowMs - minutes * 60000)]);
  };
  const finish = async () => {
    await stores.pendingEventStore.ack(activity.sessionId, activity.fence.eventId, activity.fence);
    await lifecycle.finish(activity);
  };
  it('counts 30 continuous idle minutes, survives Host restart, and fences rebuild until deletion commits', async () => {
    await finish();
    expect(await lifecycle.claimReclamation(activity.bindingId)).toBeNull();
    nowMs += 30 * 60000 - 1;
    expect(await lifecycle.claimReclamation(activity.bindingId)).toBeNull();
    nowMs += 1;
    const restarted = new PgSandboxLifecycleStore(harness.pool, clock);
    const ticket = (await restarted.claimReclamation(activity.bindingId))!;
    expect(ticket.sandboxId).toBe('sandbox-original');
    await expect(stores.delegationStore.withEnvironmentLock(activity.bindingId, async () => ({ sandboxId: 'wrong', value: undefined }))).rejects.toThrow('reclamation');
    await restarted.completeReclamation(ticket);
    expect(await stores.delegationStore.withEnvironmentLock(activity.bindingId, async id => ({ sandboxId: id, value: id }))).toBeNull();
  });
  it('retains actual executions beyond one hour even after queue removal and lease loss', async () => {
    await stores.pendingEventStore.clear(activity.sessionId);
    await ageIdle(120);
    expect(await new PgSandboxLifecycleStore(harness.pool).claimReclamation(activity.bindingId)).toBeNull();
    // Only an exact attempt settlement, not restart/lease expiry, removes use.
    await lifecycle.finish({ ...activity, fence: { ...activity.fence, generation: 99 } });
    await ageIdle(120);
    expect(await lifecycle.claimReclamation(activity.bindingId)).toBeNull();
    await lifecycle.finish(activity);
    expect(await lifecycle.claimReclamation(activity.bindingId)).toBeNull();
    await ageIdle(30);
    expect(await lifecycle.claimReclamation(activity.bindingId)).not.toBeNull();
  });
  it.each(['user.message', 'delegation_input', 'subagent.result'])('invalidates idle time for every accepted %s, even if cleared before the next sweep', async type => {
    await finish(); await lifecycle.claimReclamation(activity.bindingId); await ageIdle(60);
    await stores.pendingEventStore.enqueue(activity.sessionId, { type, data: {}, sessionThreadId: 'sthr_primary' });
    await stores.pendingEventStore.clear(activity.sessionId);
    expect(await lifecycle.claimReclamation(activity.bindingId)).toBeNull();
  });
  it('protects queued and running children while an independent Session sharing the Workspace does not protect this binding', async () => {
    const parent = (await stores.sessionStore.getById(activity.sessionId))!;
    const child = await stores.sessionStore.create({ tenantId: parent.tenantId, agentId: parent.agentId, agent: parent.agent, workspaceId: parent.workspaceId,
      delegation: { parentSessionId: parent.id, parentTurnId: 'turn', parentToolUseId: 'tool', sandboxSessionId: parent.id } });
    await stores.pendingEventStore.enqueue(child.id, { type: 'delegation_input', data: {}, sessionThreadId: 'sthr_primary' });
    await finish(); await ageIdle(60);
    expect(await lifecycle.claimReclamation(activity.bindingId)).toBeNull();
    const claim = (await stores.pendingEventStore.claim(child.id, 'child-host', 60000))!;
    const childActivity = { bindingId: parent.id, sessionId: child.id, fence: { eventId: claim.event.id, ownerId: claim.ownerId, generation: claim.generation } };
    await lifecycle.begin(childActivity);
    await stores.pendingEventStore.clear(child.id); await ageIdle(60);
    expect(await lifecycle.claimReclamation(activity.bindingId)).toBeNull();
    await lifecycle.finish(childActivity);
    const independent = await stores.sessionStore.create({ tenantId: parent.tenantId, agentId: parent.agentId, agent: parent.agent, workspaceId: parent.workspaceId });
    await stores.pendingEventStore.enqueue(independent.id, { type: 'user.message', data: {}, sessionThreadId: 'sthr_primary' });
    await ageIdle(30);
    expect(await lifecycle.claimReclamation(parent.id)).not.toBeNull();
  });
  it('protects the complete asynchronous delegation, parent result and user queue lifecycle', async () => {
    const child = await stores.delegationStore.accept({
      tenantId: 'tenant', callerSessionId: activity.sessionId, callerTurnId: 'parent-turn', callerToolUseId: 'tool',
      prompt: 'child work', mode: 'async', parentModel: 'model', maxSteps: 500, sandboxSessionId: activity.bindingId,
    }, activity.fence);
    const claim = (await stores.pendingEventStore.claim(child.childId, 'child-host', 60000))!;
    const fence = { eventId: claim.event.id, ownerId: claim.ownerId, generation: claim.generation };
    await stores.delegationStore.startExecution(child.id, fence, 'child-turn', {}, 4);
    const childActivity = { bindingId: activity.bindingId, sessionId: child.childId, fence };
    await lifecycle.begin(childActivity);
    await finish(); await ageIdle(120);
    expect(await lifecycle.claimReclamation(activity.bindingId)).toBeNull();
    const [completed, reclaimed] = await Promise.all([
      stores.delegationStore.finishExecution(child.id, fence, { status: 'completed', reason: 'runtime settled', output: 'done', trace: { sessionId: child.childId, turnId: 'child-turn' } }),
      lifecycle.claimReclamation(activity.bindingId),
    ]);
    expect(completed.notificationStatus).toBe('pending');
    expect(reclaimed).toBeNull();
    await stores.pendingEventStore.ack(child.childId, fence.eventId, fence);
    await lifecycle.finish(childActivity);
    await stores.pendingEventStore.enqueueBatchIfSessionActive(activity.sessionId, [{ type: 'user.message', data: {}, sessionThreadId: 'sthr_primary' }]);
    expect(await stores.pendingEventStore.count(activity.sessionId)).toBe(2);
    await ageIdle(120);
    expect(await lifecycle.claimReclamation(activity.bindingId)).toBeNull();
    for (let index = 0; index < 2; index++) {
      const next = (await stores.pendingEventStore.claim(activity.sessionId, 'parent-resumed', 60000))!;
      const turn = { ...activity, fence: { eventId: next.event.id, ownerId: next.ownerId, generation: next.generation } };
      await lifecycle.begin(turn);
      await stores.pendingEventStore.ack(activity.sessionId, next.event.id, turn.fence);
      await lifecycle.finish(turn);
      expect(await lifecycle.claimReclamation(activity.bindingId)).toBeNull();
    }
    await ageIdle(30);
    expect(await lifecycle.claimReclamation(activity.bindingId)).not.toBeNull();
  });
  it('orders input acceptance against a committed reclaim ticket across Hosts', async () => {
    await finish(); await ageIdle(30);
    const gate = await harness.pool.connect();
    await gate.query('BEGIN');
    await gate.query('SELECT id FROM delegation_environments WHERE id = $1 FOR UPDATE', [activity.bindingId]);
    const enqueue = stores.pendingEventStore.enqueue(activity.sessionId, { type: 'user.message', data: {}, sessionThreadId: 'sthr_primary' });
    await gate.query('UPDATE delegation_environments SET reclaiming = TRUE WHERE id = $1', [activity.bindingId]);
    await gate.query('COMMIT'); gate.release(); await enqueue;
    const claim = (await stores.pendingEventStore.claim(activity.sessionId, 'next-host', 60000))!;
    const next = { ...activity, fence: { eventId: claim.event.id, ownerId: claim.ownerId, generation: claim.generation } };
    expect(await lifecycle.begin(next)).toBe(false);
    await lifecycle.completeReclamation({ bindingId: activity.bindingId, sandboxId: 'sandbox-original' });
    expect(await lifecycle.begin(next)).toBe(true);
  });
  it('new input wins a racing reclamation check and remains protected after its transaction commits', async () => {
    await finish(); await ageIdle(30);
    const gate = await harness.pool.connect(); await gate.query('BEGIN');
    await gate.query("INSERT INTO pending_events (id, session_id, type, data, session_thread_id, arrived_at) VALUES ('racer',$1,'user.message','{}','sthr_primary',clock_timestamp())", [activity.sessionId]);
    const reclaim = new PgSandboxLifecycleStore(harness.pool).claimReclamation(activity.bindingId);
    await gate.query('COMMIT'); gate.release();
    expect(await reclaim).toBeNull();
  });
  it('does not let an old Host callback clear a new generation or an unknown older generation', async () => {
    await stores.pendingEventStore.releaseClaim(activity.sessionId, activity.fence.eventId, activity.fence);
    const claim = (await stores.pendingEventStore.claim(activity.sessionId, 'host-two', 60000))!;
    const newer = { ...activity, fence: { eventId: claim.event.id, ownerId: claim.ownerId, generation: claim.generation } };
    await lifecycle.begin(newer); await stores.pendingEventStore.clear(activity.sessionId);
    await lifecycle.finish(newer); await ageIdle(60);
    expect(await lifecycle.claimReclamation(activity.bindingId)).toBeNull();
    await lifecycle.finish(activity);
    expect(await lifecycle.claimReclamation(activity.bindingId)).toBeNull();
  });
  it('includes an existing Sandbox when its next Turn starts and waits for all activity before explicit deletion', async () => {
    expect(await lifecycle.claimReclamation(activity.bindingId, true)).toBeNull();
    await harness.pool.query('UPDATE delegation_environments SET lifecycle_managed = FALSE WHERE id = $1', [activity.bindingId]);
    expect(await lifecycle.begin(activity)).toBe(true);
    expect((await harness.pool.query('SELECT lifecycle_managed FROM delegation_environments WHERE id=$1', [activity.bindingId])).rows[0].lifecycle_managed).toBe(true);
    expect(await lifecycle.claimReclamation(activity.bindingId, true)).toBeNull();
    await finish();
    expect(await lifecycle.claimReclamation(activity.bindingId, true)).not.toBeNull();
  });
  it('includes every existing Sandbox on startup and starts a fresh 30-minute idle period', async () => {
    await finish();
    await harness.pool.query('UPDATE delegation_environments SET lifecycle_managed=FALSE WHERE id=$1', [activity.bindingId]);
    await ageIdle(120);
    await lifecycle.markAllManaged();
    expect((await harness.pool.query('SELECT lifecycle_managed, idle_since FROM delegation_environments WHERE id=$1', [activity.bindingId])).rows[0]).toEqual({ lifecycle_managed: true, idle_since: null });
    expect(await lifecycle.claimReclamation(activity.bindingId)).toBeNull();
    nowMs += 30 * 60000 - 1;
    await lifecycle.markAllManaged(); // A restart must not reset an existing idle clock.
    expect(await lifecycle.claimReclamation(activity.bindingId)).toBeNull();
    nowMs += 1;
    expect(await lifecycle.claimReclamation(activity.bindingId)).not.toBeNull();
  });
  it('finds bindings created without a Turn after startup and protects their pending input', async () => {
    await harness.pool.query('UPDATE delegation_environments SET lifecycle_managed=FALSE WHERE id=$1', [activity.bindingId]);
    expect(await lifecycle.listManagedBindings()).toContain(activity.bindingId);
    await ageIdle(120);
    expect(await lifecycle.claimReclamation(activity.bindingId)).toBeNull();
    await finish();
    expect(await lifecycle.claimReclamation(activity.bindingId)).toBeNull();
    await ageIdle(30);
    expect(await lifecycle.claimReclamation(activity.bindingId)).not.toBeNull();
  });
  it('does not serialize legacy input behind a legacy Sandbox provisioning lock', async () => {
    await harness.pool.query('UPDATE delegation_environments SET lifecycle_managed=FALSE WHERE id=$1', [activity.bindingId]);
    const gate = await harness.pool.connect();
    try {
      await gate.query('BEGIN');
      await gate.query('SELECT id FROM delegation_environments WHERE id=$1 FOR UPDATE', [activity.bindingId]);
      const input = stores.pendingEventStore.enqueue(activity.sessionId, { type: 'user.message', data: {}, sessionThreadId: 'sthr_primary' });
      const accepted = await Promise.race([input.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 1000))]);
      expect(accepted).toBe(true);
      await gate.query('COMMIT');
      await input;
    } finally { await gate.query('ROLLBACK'); gate.release(); }
  });
  it('grants the application only necessary activity privileges and permits its queue trigger', async () => {
    const schema = process.env.PG_TEST_SCHEMA ?? 'oma_test';
    const role = `${schema}_lifecycle_role`;
    const migration = (await readFile(new URL('../../../../deploy/migrations/0014_sandbox_lifecycle.sql', import.meta.url), 'utf8'))
      .replaceAll('oma.', `${schema}.`).replaceAll('oma_app', role);
    await harness.pool.query(`CREATE ROLE "${role}" NOLOGIN`);
    try {
      await harness.pool.query(migration);
      const permissions = await harness.pool.query(`SELECT has_table_privilege($1, $2, 'SELECT,INSERT,DELETE') AS usable,
        has_table_privilege($1, $2, 'UPDATE') AS updates, has_table_privilege($1, $2, 'TRUNCATE') AS truncates`, [role, `${schema}.sandbox_activities`]);
      expect(permissions.rows[0]).toEqual({ usable: true, updates: false, truncates: false });
      // Existing application privileges come from the earlier migrations.
      await harness.pool.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}";
        GRANT SELECT ON ${schema}.sessions TO "${role}";
        GRANT SELECT,INSERT,UPDATE ON ${schema}.delegation_environments TO "${role}";
        GRANT SELECT,INSERT ON ${schema}.pending_events TO "${role}";
        GRANT USAGE ON ALL SEQUENCES IN SCHEMA "${schema}" TO "${role}"`);
      await ageIdle(30);
      const connection = await harness.pool.connect();
      try {
        await connection.query('BEGIN');
        await connection.query(`SET LOCAL ROLE "${role}"`);
        await connection.query(`INSERT INTO pending_events (id,session_id,type,data,session_thread_id,arrived_at)
          VALUES ('role-input',$1,'user.message','{}','sthr_primary',clock_timestamp())`, [activity.sessionId]);
        await connection.query('COMMIT');
      } finally { await connection.query('ROLLBACK'); connection.release(); }
      expect((await harness.pool.query('SELECT idle_since FROM delegation_environments WHERE id=$1', [activity.bindingId])).rows[0].idle_since).toBeNull();
    } finally {
      await harness.pool.query(`DROP OWNED BY "${role}"; DROP ROLE "${role}"`);
    }
  });
});
