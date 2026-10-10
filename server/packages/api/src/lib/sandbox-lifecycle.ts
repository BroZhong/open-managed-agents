import { PgSandboxLifecycleStore, type Pool } from '@oma-server/store';
import type { SandboxManagerDeps } from '@oma-server/sandbox';

/** Business execution coordination for the single native lifecycle policy. */
export async function sandboxLifecycle(pool: Pool): Promise<SandboxManagerDeps['lifecycle']> {
  const store = new PgSandboxLifecycleStore(pool);
  await store.assertReady();
  return store;
}
