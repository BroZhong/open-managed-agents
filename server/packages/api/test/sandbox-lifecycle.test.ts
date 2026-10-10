import { afterEach, describe, expect, it, vi } from 'vitest';
import { sandboxLifecycle } from '../src/lib/sandbox-lifecycle.js';
import type { Pool } from '@oma-server/store';

describe('Sandbox lifecycle activation', () => {
  afterEach(() => vi.useRealTimers());
  it('constructs the unconditional lifecycle store without rollout configuration', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ ok: 1 }] });
    const pool = { query } as unknown as Pool;
    const lifecycle = await sandboxLifecycle(pool);
    expect(lifecycle).toBeDefined();
    expect(query).toHaveBeenCalledOnce();
  });
  it('requires the queue trigger before enabling native lifecycle coordination', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const pool = { query } as unknown as Pool;
    await expect(sandboxLifecycle(pool)).rejects.toThrow('migration');
    expect(query).toHaveBeenCalledOnce();
  });
});
