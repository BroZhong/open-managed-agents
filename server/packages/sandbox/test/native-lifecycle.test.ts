import { describe, it, expect, vi } from 'vitest';
import { DefaultSandboxManager, type EnvSpec } from '../src/sandbox-manager.js';
import { FakeSandboxClient } from '../src/fake-sandbox-client.js';
import type { ToolFileSystem } from '@open-managed-agents/adapter-core';
import { durableBinding, signalBus } from './bindings.js';
const spec: EnvSpec = { tenantId: 't', workspaceId: 'w', workspaceMount: {
  bucket: 'agentry', prefix: 't/w/', agentName: 'agent', pvName: 'pv', credentialProviderName: 'credentials',
} };
function setup() {
  const client = new FakeSandboxClient();
  // A Runner's handles of one binding hear its environment hints.
  const manager = new DefaultSandboxManager({ sandboxClient: client, environment: 'test', environmentSignals: signalBus() });
  return { client, manager, session: manager.open(spec, durableBinding()) };
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
  it('runs nothing in a Sandbox whose binding write was lost, and waits for its intent instead of creating again', async () => {
    const { client, manager } = setup();
    const durable = durableBinding();
    let commits = 0;
    // The intent commits; the write that records the Sandbox is lost.
    const session = manager.open(spec, { id: durable.id, withLock: work => durable.withLock(async binding => {
      const result = await work(binding);
      if (++commits === 2) throw new Error('commit response lost');
      return result;
    }) });
    // An environment failure: the tool sees a stable message, its cause is kept.
    await expect(session.writeFile('effect', 'x')).rejects.toMatchObject({ name: 'SandboxUnavailable', code: 'sandbox_unavailable',
      reason: 'unreachable', cause: expect.objectContaining({ message: 'commit response lost' }) });
    expect(durable.row()).toMatchObject({ sandboxId: null, creatingSince: expect.any(Date) });
    const turn = new AbortController();
    await session.prepare(undefined, { signal: turn.signal });
    const waiting = session.writeFile('effect', 'x');
    await new Promise(resolve => setTimeout(resolve, 250));
    turn.abort(new DOMException('Session interrupted', 'AbortError'));
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    expect(client.created).toHaveLength(1);
    expect(client.workspaceContents('t/w/').size).toBe(0);
  });
});

describe('native lifecycle concurrency and late writes', () => {
  it('shares creation across independent handles of one binding', async () => {
    const { client, manager } = setup();
    const binding = durableBinding();
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
    const binding = durableBinding();
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

  /** A native write that completes, then sees its caller's Interrupt; `lost` drops its outcome instead. */
  function interruptedWrite(client: FakeSandboxClient, controller: AbortController, lost = false) {
    const unavailable = () => { throw new Error('Unexpected filesystem operation'); };
    const fileSystem = (id: string): ToolFileSystem => ({
      writeFile: async (path, content, options) => {
        await client.writeFileBytes(id, path, content as Uint8Array);
        controller.abort();
        if (lost) vi.spyOn(client, 'hasUncertainExecution').mockReturnValue(true);
        options?.signal?.throwIfAborted();
      },
      readFile: unavailable, appendFile: unavailable, access: unavailable, stat: unavailable, lstat: unavailable,
      realpath: unavailable, readdir: unavailable, mkdir: unavailable, createTempFile: unavailable,
    });
    Object.assign(client, { fileSystem });
  }

  it('keeps a Turn settled when an Interrupt cancels a filesystem operation whose outcome is known', async () => {
    const { client, session } = setup();
    await session.writeFile('saved', 'value');
    const controller = new AbortController();
    interruptedWrite(client, controller);
    await expect(session.fileSystem.writeFile('request.json', new Uint8Array([1]), { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(session.executionSettled!()).toBe(true);
    await expect(session.checkWorkspace()).resolves.toBeUndefined();
  });

  it('keeps a Turn uncertain when the client lost the outcome of an interrupted filesystem operation', async () => {
    const { client, session } = setup();
    await session.writeFile('saved', 'value');
    const controller = new AbortController();
    interruptedWrite(client, controller, true);
    await expect(session.fileSystem.writeFile('request.json', new Uint8Array([1]), { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    vi.mocked(client.hasUncertainExecution).mockRestore();
    // Latched for the Turn: a sibling's preparation resetting the client does not settle it.
    expect(client.hasUncertainExecution(client.created[0])).toBe(false);
    expect(session.executionSettled!()).toBe(false);
    await expect(session.checkWorkspace()).rejects.toThrow(/Workspace storage/);
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
