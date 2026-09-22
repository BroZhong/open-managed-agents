import { afterEach, describe, expect, it, vi } from 'vitest';
import { sandboxLifecycleFromEnv, startSandboxSweeper } from '../src/lib/sandbox-lifecycle.js';
import type { Pool } from '@oma-server/store';

describe('controlled Sandbox lifecycle activation', () => {
  afterEach(() => vi.useRealTimers());
  it('does no persistence work when disabled and rejects wildcard activation', async () => {
    const query = vi.fn();
    const pool = { query } as unknown as Pool;
    expect(await sandboxLifecycleFromEnv(pool, {})).toBeUndefined();
    expect(query).not.toHaveBeenCalled();
    await expect(sandboxLifecycleFromEnv(pool, { SANDBOX_IDLE_BINDINGS: '*' })).rejects.toThrow('explicit');
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
