import { afterEach, describe, expect, it, vi } from 'vitest';
import { sandboxLifecycleFromEnv, startSandboxSweeper } from '../src/lib/sandbox-lifecycle.js';
import type { Pool } from '@oma-server/store';

describe('Sandbox lifecycle activation', () => {
  afterEach(() => vi.useRealTimers());
  it('does no persistence work when disabled and enables all bindings when the sweep is enabled', async () => {
    const query = vi.fn();
    const pool = { query } as unknown as Pool;
    expect(await sandboxLifecycleFromEnv(pool, {})).toBeUndefined();
    expect(query).not.toHaveBeenCalled();
    query.mockResolvedValue({ rows: [{ ok: 1 }] });
    const lifecycle = await sandboxLifecycleFromEnv(pool, { SANDBOX_IDLE_SWEEP: 'true' });
    expect(lifecycle?.allBindings).toBe(true);
    expect(lifecycle?.bindingIds).toEqual(new Set());
    expect(query).toHaveBeenCalledOnce();
  });
  it('rejects mixing the all-bindings mode with an explicit selector', async () => {
    const query = vi.fn();
    const pool = { query } as unknown as Pool;
    await expect(sandboxLifecycleFromEnv(pool, { SANDBOX_IDLE_ALL: 'true', SANDBOX_IDLE_BINDINGS: 'root' })).rejects.toThrow('combined');
    expect(query).not.toHaveBeenCalled();
  });
  it('refuses enablement without the queue trigger or with unverified existing bindings', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const pool = { query } as unknown as Pool;
    await expect(sandboxLifecycleFromEnv(pool, { SANDBOX_IDLE_BINDINGS: 'root' })).rejects.toThrow('migration');
    query.mockResolvedValue({ rows: [{ id: 'root' }] });
    await expect(sandboxLifecycleFromEnv(pool, { SANDBOX_IDLE_BINDINGS: 'root' })).rejects.toThrow('adoption');
  });
  it('does not overlap slow sweeps, reports failures, and stops scheduling on rollback', async () => {
    vi.useFakeTimers();
    let reject!: (reason: Error) => void;
    const sweep = vi.fn(() => new Promise<void>((_, fail) => { reject = fail; }));
    const report = vi.fn();
    const stop = startSandboxSweeper(sweep, report);
    await vi.advanceTimersByTimeAsync(120000);
    expect(sweep).toHaveBeenCalledOnce();
    reject(new Error('database unavailable'));
    await vi.advanceTimersByTimeAsync(30000);
    expect(report).toHaveBeenCalledOnce();
    expect(sweep).toHaveBeenCalledTimes(2);
    stop();
    reject(new Error('delete acknowledgement lost'));
    await vi.advanceTimersByTimeAsync(120000);
    expect(sweep).toHaveBeenCalledTimes(2);
  });
});
