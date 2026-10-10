import { describe, it, expect, vi } from 'vitest';
import { DefaultSandboxManager, type EnvSpec } from '../src/sandbox-manager.js';
import { FakeSandboxClient } from '../src/fake-sandbox-client.js';
const spec: EnvSpec = { tenantId: 't', workspaceId: 'w', workspaceMount: {
  bucket: 'agentry', prefix: 't/w/', agentName: 'agent', pvName: 'pv', credentialProviderName: 'credentials',
} };
function setup() {
  const client = new FakeSandboxClient();
  const manager = new DefaultSandboxManager({ sandboxClient: client, provisionSources: {} });
  return { client, manager, session: manager.open(spec) };
}
describe('native lifecycle per Turn', () => {
  it('keeps chat cold and prepares only once per Turn, refreshing on the next Turn', async () => {
    const { client, session } = setup();
    const reconnect = vi.spyOn(client, 'reconnect');
    await session.prepare();
    expect(client.created).toHaveLength(0);
    await session.writeFile('saved', 'yes');
    await session.readFile('saved');
    await session.list();
    expect(client.mountChecks).toHaveLength(1);
    expect(reconnect).not.toHaveBeenCalled();
    await session.prepare();
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(client.mountChecks).toHaveLength(2);
    await session.readFile('saved');
    expect(client.mountChecks).toHaveLength(2);
  });
  it('reports a paused operation as uncertain and restores the same resource for a subsequent tool', async () => {
    const { client, session } = setup();
    await session.writeFile('saved', 'once');
    client.pause(client.created[0]);
    await expect(session.writeFile('saved', 'twice')).rejects.toThrow(/not replayed/);
    expect(await session.readFile('saved')).toBe('once');
    expect(client.created).toHaveLength(1);
  });
  it('rebuilds after confirmed deletion without replaying the failed operation', async () => {
    const { client, session } = setup();
    await session.writeFile('saved', 'once');
    client.reclaim(client.created[0]);
    await expect(session.writeFile('saved', 'twice')).rejects.toThrow(/not replayed/);
    expect(await session.readFile('saved')).toBe('once');
    expect(client.created).toHaveLength(2);
  });
  it('does not replace a resource on a control-plane timeout, and can recover on the next call', async () => {
    const { client, session } = setup();
    await session.writeFile('saved', 'once');
    client.pause(client.created[0]);
    vi.spyOn(client, 'state').mockRejectedValueOnce(new Error('network timeout'));
    await expect(session.readFile('saved')).rejects.toThrow(/unconfirmed/);
    expect(client.created).toHaveLength(1);
    expect(await session.readFile('saved')).toBe('once');
  });
  it('never executes or creates again after an ambiguous binding commit', async () => {
    const { client, manager } = setup();
    let stored: string | null = null;
    let commits = 0;
    const session = manager.open(spec, { withLock: async work => {
      const result = await work(stored);
      if (++commits === 2) throw new Error('commit response lost');
      stored = result.sandboxId; return result.value;
    } });
    await expect(session.writeFile('effect', 'x')).rejects.toThrow('commit response lost');
    await expect(session.writeFile('effect', 'x')).rejects.toThrow(/unconfirmed/);
    expect(client.created).toHaveLength(1);
    expect(client.workspaceContents('t/w/').size).toBe(0);
  });
});

describe('native lifecycle concurrency and late writes', () => {
  it('shares creation across independent handles of one binding', async () => {
    const { client, manager } = setup();
    let id: string | null = null;
    let pending = false;
    let lock: Promise<unknown> = Promise.resolve();
    const binding = { withLock<T>(work: (id: string | null, pending?: boolean) => Promise<{ sandboxId: string | null; creationPending?: boolean; value: T }>): Promise<T> {
      const result = lock.then(async () => {
        const value = await work(id, pending);
        id = value.sandboxId; pending = value.creationPending ?? pending;
        return value.value;
      });
      lock = result.catch(() => {}); return result;
    } };
    const first = manager.open(spec, binding), second = manager.open(spec, binding);
    await Promise.all([first.writeFile('one', 'one'), second.writeFile('two', 'two')]);
    expect(client.created).toHaveLength(1);
    expect(await first.readFile('two')).toBe('two');
  });
  it('handles a late idle write that overrides the new Turn deadline without replaying a side effect', async () => {
    const { client, session } = setup();
    await session.writeFile('effect', 'once');
    const id = client.created[0];
    // Remote completion after the caller lost its response is outside DB fencing.
    const lateIdleWrite = () => client.pause(id);
    await session.prepare(); // New Turn refreshes 24h.
    expect(client.deadlines.at(-1)).toEqual({ id, seconds: 86400 });
    lateIdleWrite(); // Simulate the old 30m timeout taking effect and expiring.
    await expect(session.writeFile('effect', 'twice')).rejects.toThrow(/not replayed/);
    expect(await session.readFile('effect')).toBe('once');
    expect(client.created).toHaveLength(1);
  });
  it('keeps partial output and does not replay a command with an observable side effect', async () => {
    const { client, session } = setup();
    await session.writeFile('effect', 'zero');
    const execute = vi.spyOn(client, 'exec').mockImplementationOnce(async function* () {
      await client.writeFile(client.created[0], '/home/user/workspace/effect', 'once');
      yield { stream: 'stdout' as const, text: 'PARTIAL' };
      client.pause(client.created[0]);
      throw new Error('stream disconnected');
    });
    const chunks: string[] = [];
    await expect((async () => { for await (const chunk of session.exec(['side-effect'])) chunks.push(chunk.text); })()).rejects.toThrow(/unconfirmed/);
    expect(chunks).toEqual(['PARTIAL']);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(await session.readFile('effect')).toBe('once');
  });
});

describe('Turn-scoped remote exit evidence', () => {
  it('retains uncertainty after iterator abandonment even when a sibling prepares the shared resource', async () => {
    const { client, manager } = setup();
    let id: string | null = null;
    const binding = { withLock: async <T>(work: (id: string | null) => Promise<{ sandboxId: string | null; value: T }>) => {
      const result = await work(id); id = result.sandboxId; return result.value;
    } };
    const parent = manager.open(spec, binding);
    await parent.writeFile('saved', 'kept');
    vi.spyOn(client, 'exec').mockImplementationOnce(async function* () {
      yield { stream: 'stdout' as const, text: 'PARTIAL' };
      // A consumer return() ends this iterator without remote exit evidence.
    });
    const iterator = parent.exec(['long-command'])[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return!();
    const sibling = manager.open(spec, binding);
    await sibling.prepare();
    expect(parent.executionSettled!()).toBe(false);
    expect(sibling.executionSettled!()).toBe(true);
  });
});

it('distinguishes commands aborted before issuance from an unknown remote exit', async () => {
  const { session } = setup();
  await session.writeFile('saved', 'value');
  const controller = new AbortController(); controller.abort();
  await expect((async () => { for await (const _ of session.exec(['never-issued'], { signal: controller.signal })) {} })()).rejects.toMatchObject({ code: 'EXEC_ABORTED_BEFORE_START' });
  expect(session.executionSettled!()).toBe(true);
  const exits = vi.fn();
  for await (const _ of session.exec(['echo', 'completed'], { onExit: exits })) {}
  expect(exits).toHaveBeenCalledExactlyOnceWith({ exitCode: 0 });
  expect(session.executionSettled!()).toBe(true);
});
