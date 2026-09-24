import { PgSandboxLifecycleStore, type Pool } from '@oma-server/store';
import type { SandboxManagerDeps } from '@oma-server/sandbox';

/** Lifecycle activation. Explicit IDs remain supported for rollback; an enabled sweep with no IDs means all bindings. */
export async function sandboxLifecycleFromEnv(pool: Pool, env: NodeJS.ProcessEnv): Promise<SandboxManagerDeps['lifecycle']> {
  const ids = (env.SANDBOX_IDLE_BINDINGS ?? '').split(',').map(id => id.trim()).filter(Boolean);
  const allBindings = env.SANDBOX_IDLE_ALL === 'true' || (env.SANDBOX_IDLE_SWEEP === 'true' && ids.length === 0);
  if (!ids.length && !allBindings) return undefined;
  if (allBindings && ids.length) throw new Error('SANDBOX_IDLE_ALL cannot be combined with SANDBOX_IDLE_BINDINGS');
  if (ids.some(id => !/^[A-Za-z0-9_-]{1,128}$/.test(id))) throw new Error('SANDBOX_IDLE_BINDINGS must contain explicit root Session IDs');
  const store = new PgSandboxLifecycleStore(pool);
  await store.assertReady();
  const bindingIds = new Set(ids);
  if (!allBindings) await store.assertBindings(bindingIds);
  return { store, bindingIds, allBindings };
}

/** No overlapping sweeps; failures retain resources and remain observable. */
export function startSandboxSweeper(sweep: () => Promise<void>, report: (error: unknown) => void): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await sweep(); } catch (error) { report(error); } finally { running = false; }
  };
  const timer = setInterval(() => { void tick(); }, 30_000);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}
