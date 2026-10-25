import type { SandboxSignals } from "@oma-server/sandbox";
import type { SessionSignals } from "@oma-server/redis";

/**
 * A binding's `sandbox` hint as a control signal whose `sessionId` is the
 * binding id (ADR-0023): the channel every Runner already subscribes to for
 * wake and check, so waiting for a binding subscribes no other channel.
 */
export function sandboxSignals(signals: SessionSignals): SandboxSignals {
  return {
    publish: (bindingId) => signals.publish({ sessionId: bindingId, kind: "sandbox" }),
    subscribe: (listener) => signals.subscribe("control", (signal) => {
      if (signal.kind === "sandbox") listener(signal.sessionId);
    }),
  };
}
