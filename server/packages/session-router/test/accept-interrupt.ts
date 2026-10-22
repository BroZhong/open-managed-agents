import type { PendingEventStore } from "@oma-server/store";

/**
 * Accept an Interrupt as the API does (routes/events.ts): durably, under the
 * claim of the Turn it stops, then hint the Runner that owns the Turn, when
 * the hint reaches one, so its heartbeat reads the Interrupt now.
 */
export async function acceptInterrupt(
  store: Pick<PendingEventStore, "requestInterrupt">,
  sessionId: string,
  owner?: { checkNow(sessionId: string): void },
): Promise<boolean> {
  const requested = await store.requestInterrupt(sessionId);
  if (requested) owner?.checkNow(sessionId);
  return requested;
}
