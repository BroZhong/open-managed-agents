import { PgSandboxLifecycleStore, type Pool } from '@oma-server/store';
import type { SandboxManagerDeps } from '@oma-server/sandbox';

/** Every Sandbox uses the same lifecycle; activation is unconditional. */
export async function sandboxLifecycle(pool: Pool): Promise<SandboxManagerDeps['lifecycle']> {
  const store = new PgSandboxLifecycleStore(pool);
  await store.assertReady();
  return store;
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
