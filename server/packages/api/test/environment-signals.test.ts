import { describe, expect, it } from "vitest";
import { sessionSignalScope, type SessionSignal, type SessionSignalScope, type SessionSignals } from "@oma-server/redis";
import { environmentSignals } from "../src/lib/environment-signals.js";

/** One Redis for every process: each signal reaches the subscribers of its scope. */
class Signals implements SessionSignals {
  readonly published: SessionSignal[] = [];
  readonly subscriptions: SessionSignalScope[] = [];
  private readonly listeners = new Set<{ scope: SessionSignalScope; listener: (signal: SessionSignal) => void }>();
  publish(signal: SessionSignal): void {
    this.published.push(signal);
    for (const { scope, listener } of this.listeners) if (scope === sessionSignalScope(signal.kind)) listener(signal);
  }
  subscribe(scope: SessionSignalScope, listener: (signal: SessionSignal) => void): () => void {
    this.subscriptions.push(scope);
    const entry = { scope, listener };
    this.listeners.add(entry);
    return () => { this.listeners.delete(entry); };
  }
}

describe("a binding's environment hint on the session signals (ADR-0023)", () => {
  it("is a control signal whose sessionId is the binding id, heard on the control channel only", () => {
    const signals = new Signals();
    const hints = environmentSignals(signals);
    const heard: string[] = [];
    const unsubscribe = hints.subscribe((bindingId) => heard.push(bindingId));
    expect(signals.subscriptions).toEqual(["control"]);

    hints.publish("sess_root");
    // Other control signals and every output signal are not hints.
    signals.publish({ sessionId: "sess_other", kind: "wake" });
    signals.publish({ sessionId: "sess_other", kind: "check" });
    signals.publish({ sessionId: "sess_other", kind: "durable" });
    expect(signals.published[0]).toEqual({ sessionId: "sess_root", kind: "environment" });
    expect(sessionSignalScope("environment")).toBe("control");
    expect(heard).toEqual(["sess_root"]);

    unsubscribe();
    hints.publish("sess_root");
    expect(heard).toEqual(["sess_root"]);
  });
});
