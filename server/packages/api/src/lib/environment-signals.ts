import type { EnvironmentSignals } from "@oma-server/sandbox";
import type { SessionSignals } from "@oma-server/redis";

/**
 * A binding's `environment` hint as a control signal whose `sessionId` is the
 * binding id (ADR-0023): the channel every Runner already subscribes to for
 * wake and check, so waiting for a binding subscribes no other channel.
 */
export function environmentSignals(signals: SessionSignals): EnvironmentSignals {
  return {
    publish: (bindingId) => signals.publish({ sessionId: bindingId, kind: "environment" }),
    subscribe: (listener) => signals.subscribe("control", (signal) => {
      if (signal.kind === "environment") listener(signal.sessionId);
    }),
  };
}
