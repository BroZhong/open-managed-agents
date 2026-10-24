import { PgSandboxLifecycleStore, type Pool } from '@oma-server/store';

/** Business execution coordination for the single native lifecycle policy, and the sweeper's read. */
export async function sandboxLifecycle(pool: Pool): Promise<PgSandboxLifecycleStore> {
  const store = new PgSandboxLifecycleStore(pool);
  await store.assertReady();
  return store;
}
