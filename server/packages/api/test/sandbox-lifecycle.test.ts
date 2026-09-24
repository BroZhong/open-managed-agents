import { afterEach, describe, expect, it, vi } from 'vitest';
import { sandboxLifecycle, startSandboxSweeper } from '../src/lib/sandbox-lifecycle.js';
import type { Pool } from '@oma-server/store';

describe('Sandbox lifecycle activation', () => {
  afterEach(() => vi.useRealTimers());
  it('manages all existing bindings by default without rollout configuration', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ ok: 1 }] });
    const pool = { query } as unknown as Pool;
    const lifecycle = await sandboxLifecycle(pool);
    expect(lifecycle?.allBindings).toBe(true);
    expect(lifecycle?.bindingIds).toEqual(new Set());
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][0]).toContain('SET lifecycle_managed=TRUE, idle_since=NULL WHERE lifecycle_managed=FALSE');
  });
  it('does not require rollout configuration', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ ok: 1 }] });
    const pool = { query } as unknown as Pool;
    const lifecycle = await sandboxLifecycle(pool);
    expect(lifecycle?.allBindings).toBe(true);
    expect(lifecycle?.bindingIds.size).toBe(0);
  });
  it('requires the queue trigger before enabling idle reclamation', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const pool = { query } as unknown as Pool;
    await expect(sandboxLifecycle(pool)).rejects.toThrow('migration');
    expect(query).toHaveBeenCalledOnce();
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
