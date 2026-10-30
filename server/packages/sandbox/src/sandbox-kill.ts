import type { SandboxClient } from "./sandbox-client.js";
import { SANDBOX_BINDING_LABEL } from "./sandbox-sweep.js";

/** How killing some Sandboxes went: each one ended confirmed missing or failed. */
export interface SandboxKills {
  /** Confirmed missing, including those the gateway no longer had. */
  killed: string[];
  failed: Array<{ sandboxId: string; error: unknown }>;
}

/**
 * Kill each Sandbox and confirm it missing: `SandboxClient.destroy` resolves
 * only once the gateway no longer has it. One at a time, and every one is
 * attempted: a failed kill does not stop the others. It decides nothing; the
 * caller chose the Sandboxes under the binding's row lock, as termination's
 * reclamation and the sweeper (ADR-0023) do.
 */
export async function killSandboxes(client: Pick<SandboxClient, "destroy">, sandboxIds: Iterable<string>): Promise<SandboxKills> {
  const kills: SandboxKills = { killed: [], failed: [] };
  for (const sandboxId of new Set(sandboxIds)) {
    try {
      await client.destroy(sandboxId);
      kills.killed.push(sandboxId);
    } catch (error) {
      kills.failed.push({ sandboxId, error });
    }
  }
  return kills;
}

/**
 * Kill every Sandbox of a binding that is reclaimed (ADR-0023, "Release and
 * reclamation"): the one the binding records, then every one the gateway
 * lists for it (`oma.dev/binding`). The list filters by the exact label
 * value, so no other binding's Sandbox is touched. Resolves the killed ids
 * once all are confirmed missing; otherwise rejects with the first failure,
 * after attempting the rest, and the reclamation is retried.
 */
export async function killBindingSandboxes(client: Pick<SandboxClient, "destroy" | "listSandboxes">,
  bindingId: string, recorded: string | null): Promise<string[]> {
  // The recorded one first: it goes even when the list fails.
  const first = await killSandboxes(client, recorded ? [recorded] : []);
  const listed = await client.listSandboxes({ metadata: { [SANDBOX_BINDING_LABEL]: bindingId } });
  const rest = await killSandboxes(client, listed.map(({ sandboxId }) => sandboxId).filter((id) => id !== recorded));
  const [failure] = [...first.failed, ...rest.failed];
  if (failure) throw failure.error;
  return [...first.killed, ...rest.killed];
}
