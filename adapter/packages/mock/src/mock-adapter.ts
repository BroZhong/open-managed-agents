import type {
  Adapter,
  AdapterInput,
  SessionEvent,
  StreamEvent,
} from "@open-managed-agents/adapter-core";
import {
  generateEventId,
  generateTimestamp,
  isStreamEvent,
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
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    },
  ];
}

/** Complete Event types that replace each kind of stream block. */
const COMPLETE_TYPES_BY_STREAM_START: Readonly<Record<string, readonly string[]>> = {
  "agent.message_stream_start": ["agent.message"],
  "agent.thinking_stream_start": ["agent.thinking"],
  "agent.tool_use_input_stream_start": ["agent.tool_use", "agent.mcp_tool_use"],
};

/**
 * Numbers a run's output blocks from the Host's base (ADR-0020), by the
 * rules the Router applied before Adapters owned alignment: each stream start
 * opens the next block, a Delta belongs to the latest started block, and a
 * Complete Event takes the latest unclaimed start of its kind (of its own
 * call, for a tool argument stream).
 */
class StreamBlocks {
  private current: number;
  private readonly open: Array<{ blockIndex: number; types: readonly string[]; toolUseId?: string }> = [];

  constructor(blockBase: number) {
    this.current = blockBase - 1;
  }

  delta(event: StreamEvent): number {
    const types = COMPLETE_TYPES_BY_STREAM_START[event.type];
    if (types) {
      this.current++;
      this.open.push({ blockIndex: this.current, types,
        ...(event.type === "agent.tool_use_input_stream_start" ? { toolUseId: event.toolUseId } : {}) });
    }
    return Math.max(0, this.current);
  }

  complete<T extends Exclude<SessionEvent, StreamEvent>>(event: T): T {
    const toolUseId = "toolUseId" in event ? event.toolUseId : undefined;
    for (let i = this.open.length - 1; i >= 0; i--) {
      const block = this.open[i]!;
      if (!block.types.includes(event.type)) continue;
      if (block.toolUseId !== undefined && block.toolUseId !== toolUseId) continue;
      this.open.splice(i, 1);
      // Only the streamed block types matched above carry a blockIndex.
      return { ...event, blockIndex: block.blockIndex } as T;
    }
    return event;
  }
}

/**
 * Writes one Adapter run's events through its Turn journal, in order: each
 * Delta on its numbered block, each Complete Event aligned with its stream
 * block and durable before the next event is written. The mock writes its
 * script with it; a hand-written test Adapter can write its events the same
 * way.
 */
export function journalWriter(
  { journal, blockBase = 0 }: Pick<AdapterInput, "journal" | "blockBase">,
): (event: SessionEvent) => Promise<void> {
  if (!journal) throw new Error("This Adapter writes through the Turn journal (ADR-0020)");
  const blocks = new StreamBlocks(blockBase);
  return async (event) => {
    if (isStreamEvent(event)) return journal.delta(event, blocks.delta(event));
    journal.record(blocks.complete(event));
    await journal.flush();
  };
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

  async *run(input: AdapterInput): AsyncIterable<SessionEvent> {
    const events =
      this.customEvents !== undefined
        ? this.customEvents
        : buildDefaultEvents();
    const write = journalWriter(input);
    try {
      for (let i = 0; i < events.length; i++) {
        if (i > 0 && this.delayMs > 0) await delay(this.delayMs);
        // An Interrupt ends the script; the Host ends the Turn.
        if (input.signal?.aborted) return;
        await write(events[i]!);
      }
    } catch {
      // A failed write fails the journal for good; the Host stops the
      // attempt on it (ADR-0020), so the script just ends here.
    }
  }
}
