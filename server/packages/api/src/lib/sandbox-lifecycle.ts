import { PgSandboxLifecycleStore, type Pool } from '@oma-server/store';
import type { SandboxManagerDeps } from '@oma-server/sandbox';

/** Controlled rollout only: root Session IDs, never Workspace or Agent IDs. */
export async function sandboxLifecycleFromEnv(pool: Pool, env: NodeJS.ProcessEnv): Promise<SandboxManagerDeps['lifecycle']> {
  const ids = (env.SANDBOX_IDLE_BINDINGS ?? '').split(',').map(id => id.trim()).filter(Boolean);
  if (!ids.length) return undefined;
  if (ids.some(id => !/^[A-Za-z0-9_-]{1,128}$/.test(id))) throw new Error('SANDBOX_IDLE_BINDINGS must contain explicit root Session IDs');
  const store = new PgSandboxLifecycleStore(pool);
  await store.assertReady();
  const bindingIds = new Set(ids);
  await store.assertBindings(bindingIds);
  return { store, bindingIds };
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
