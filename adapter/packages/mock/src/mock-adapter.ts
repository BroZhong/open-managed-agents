import type {
  Adapter,
  AdapterInput,
  SessionEvent,
} from "@open-managed-agents/adapter-core";
import {
  generateEventId,
  generateTimestamp,
} from "@open-managed-agents/adapter-core";

export interface MockAdapterOptions {
  events?: SessionEvent[];
  delayMs?: number;
}

function buildDefaultEvents(): SessionEvent[] {
  // No session.status_running / session.status_idle here — those lifecycle
  // events are owned solely by the Host router, which persists exactly one of
  // each per turn (issue #83). An adapter that also yielded them would double
  // the count in the event log.
  return [
    {
      id: generateEventId(),
      timestamp: generateTimestamp(),
      type: "span.model_request_start",
      model: "mock-model",
    },
    {
      id: generateEventId(),
      timestamp: generateTimestamp(),
      type: "agent.message_stream_start",
    },
    {
      id: generateEventId(),
      timestamp: generateTimestamp(),
      type: "agent.message_chunk",
      text: "Hello",
    },
    {
      id: generateEventId(),
      timestamp: generateTimestamp(),
      type: "agent.message_chunk",
      text: ", ",
    },
    {
      id: generateEventId(),
      timestamp: generateTimestamp(),
      type: "agent.message_chunk",
      text: "world!",
    },
    {
      id: generateEventId(),
      timestamp: generateTimestamp(),
      type: "agent.message_stream_end",
    },
    {
      id: generateEventId(),
      timestamp: generateTimestamp(),
      type: "agent.message",
      content: [{ type: "text", text: "Hello, world!" }],
    },
    {
      id: generateEventId(),
      timestamp: generateTimestamp(),
      type: "span.model_request_end",
      usage: { inputTokens: 10, outputTokens: 5 },
    },
  ];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class MockAdapter implements Adapter {
  private readonly customEvents: SessionEvent[] | undefined;
  private readonly delayMs: number;

  constructor(options?: MockAdapterOptions) {
    this.customEvents = options?.events;
    this.delayMs = options?.delayMs ?? 0;
  }

  async *run(_input: AdapterInput): AsyncIterable<SessionEvent> {
    const events =
      this.customEvents !== undefined
        ? this.customEvents
        : buildDefaultEvents();

    for (let i = 0; i < events.length; i++) {
      if (i > 0 && this.delayMs > 0) {
        await delay(this.delayMs);
      }
      yield events[i]!;
    }
  }
}
