import type { OutputBlockRef, SessionDelta, SessionEvent } from "@/lib/types";

export interface SessionEventStreamState {
  events: SessionEvent[];
  activeDeltas: SessionDelta[];
  completedBlocks: ReadonlySet<string>;
  seenDeltaIds: ReadonlySet<string>;
  latestDeltaBlock?: OutputBlockRef;
}

export type SessionEventStreamAction =
  | { type: "history.loaded"; events: SessionEvent[] }
  | { type: "event.received"; event: SessionEvent }
  | { type: "delta.received"; delta: SessionDelta };

export type ParsedSessionSseFrame =
  | { kind: "event"; event: SessionEvent }
  | { kind: "delta"; delta: SessionDelta };

export const initialSessionEventStreamState: SessionEventStreamState = {
  events: [],
  activeDeltas: [],
  completedBlocks: new Set(),
  seenDeltaIds: new Set(),
};

export function sessionEventStreamUrl(baseUrl: string, sessionId: string): string {
  return `${baseUrl}/v1/sessions/${sessionId}/events?include=chunks`;
}

const LIVE_PROJECTION_END_TYPES: ReadonlySet<string> = new Set([
  "session.error",
  "session.status_idle",
]);

function blockKey(block: OutputBlockRef): string {
  return `${block.turnId}:${block.blockIndex}`;
}

function completeEventBlock(event: SessionEvent): OutputBlockRef | undefined {
  if (!event.data || typeof event.data !== "object") return undefined;
  const data = event.data as Record<string, unknown>;
  if (typeof data.turnId !== "string" || typeof data.blockIndex !== "number") {
    return undefined;
  }
  return { turnId: data.turnId, blockIndex: data.blockIndex };
}

function completedBlocksOf(events: SessionEvent[]): ReadonlySet<string> {
  const completed = new Set<string>();
  for (const event of events) {
    const block = completeEventBlock(event);
    if (block !== undefined) completed.add(blockKey(block));
  }
  return completed;
}

function timestampOf(data: Record<string, unknown>): string {
  if (typeof data.ts === "string") return data.ts;
  if (typeof data.timestamp === "string") return data.timestamp;
  return new Date().toISOString();
}

/** Parse one complete SSE frame into either durable history or a transient Delta. */
export function parseSessionSseFrame(frame: string): ParsedSessionSseFrame | null {
  let eventId = "";
  let eventType = "";
  const dataLines: string[] = [];

  for (const line of frame.split("\n")) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const field = line.slice(0, separator);
    const rawValue = line.slice(separator + 1);
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
    if (field === "id") eventId = value;
    else if (field === "event") eventType = value;
    else if (field === "data") dataLines.push(value);
  }

  if (dataLines.length === 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(dataLines.join("\n"));
  } catch {
    return null;
  }

  const record =
    parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : undefined;
  const type =
    eventType || (record && typeof record.type === "string" ? record.type : "");
  const data = record?.data ?? parsed;

  if (eventId !== "") {
    const seq = Number.parseInt(eventId, 10);
    if (!Number.isFinite(seq)) return null;
    return {
      kind: "event",
      event: {
        seq,
        type,
        data,
        ts: record ? timestampOf(record) : new Date().toISOString(),
      },
    };
  }

  if (
    !record ||
    typeof record.turnId !== "string" ||
    typeof record.blockIndex !== "number"
  ) {
    return null;
  }

  return {
    kind: "delta",
    delta: {
      type,
      data,
      ts: timestampOf(record),
      turnId: record.turnId,
      blockIndex: record.blockIndex,
      deltaId: typeof record.deltaId === "string" ? record.deltaId : undefined,
    },
  };
}

export function sessionEventStreamReducer(
  state: SessionEventStreamState,
  action: SessionEventStreamAction,
): SessionEventStreamState {
  switch (action.type) {
    case "history.loaded":
      return {
        events: action.events,
        activeDeltas: [],
        completedBlocks: completedBlocksOf(action.events),
        seenDeltaIds: new Set(),
        latestDeltaBlock: undefined,
      };

    case "delta.received": {
      const key = blockKey(action.delta);
      if (state.completedBlocks.has(key)) return state;
      if (action.delta.deltaId !== undefined && state.seenDeltaIds.has(action.delta.deltaId)) {
        return state;
      }

      const seenDeltaIds = new Set(state.seenDeltaIds);
      if (action.delta.deltaId !== undefined) seenDeltaIds.add(action.delta.deltaId);

      if (
        state.latestDeltaBlock?.turnId === action.delta.turnId &&
        action.delta.blockIndex < state.latestDeltaBlock.blockIndex
      ) {
        return { ...state, seenDeltaIds };
      }

      const current = state.activeDeltas[0];
      const sameBlock =
        current !== undefined &&
        current.turnId === action.delta.turnId &&
        current.blockIndex === action.delta.blockIndex;
      return {
        ...state,
        activeDeltas: sameBlock
          ? [...state.activeDeltas, action.delta]
          : [action.delta],
        seenDeltaIds,
        latestDeltaBlock: {
          turnId: action.delta.turnId,
          blockIndex: action.delta.blockIndex,
        },
      };
    }

    case "event.received": {
      const block = completeEventBlock(action.event);
      const key = block === undefined ? undefined : blockKey(block);
      const completedBlocks = new Set(state.completedBlocks);
      if (key !== undefined) completedBlocks.add(key);
      const liveProjectionEnded = LIVE_PROJECTION_END_TYPES.has(action.event.type);

      return {
        ...state,
        events: state.events.some((event) => event.seq === action.event.seq)
          ? state.events
          : [...state.events, action.event],
        activeDeltas: liveProjectionEnded
          ? []
          : key === undefined
            ? state.activeDeltas
            : state.activeDeltas.filter(
                (delta) => blockKey(delta) !== key,
              ),
        completedBlocks,
      };
    }
  }
}
