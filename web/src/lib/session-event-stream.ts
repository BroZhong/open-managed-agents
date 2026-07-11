import type { SessionDelta, SessionEvent } from "@/lib/types";

export interface SessionEventStreamState {
  events: SessionEvent[];
  activeDeltas: SessionDelta[];
  completedBlocks: ReadonlySet<string>;
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
};

export function sessionEventStreamUrl(baseUrl: string, sessionId: string): string {
  return `${baseUrl}/v1/sessions/${sessionId}/events?include=chunks`;
}

const LIVE_PROJECTION_END_TYPES: ReadonlySet<string> = new Set([
  "session.error",
  "session.status_idle",
]);

function blockKey(turnId: string, blockIndex: number): string {
  return `${turnId}:${blockIndex}`;
}

function completeEventBlockKey(event: SessionEvent): string | undefined {
  if (!event.data || typeof event.data !== "object") return undefined;
  const data = event.data as Record<string, unknown>;
  if (typeof data.turnId !== "string" || typeof data.blockIndex !== "number") {
    return undefined;
  }
  return blockKey(data.turnId, data.blockIndex);
}

function completedBlocksOf(events: SessionEvent[]): ReadonlySet<string> {
  const completed = new Set<string>();
  for (const event of events) {
    const key = completeEventBlockKey(event);
    if (key !== undefined) completed.add(key);
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
      };

    case "delta.received": {
      const key = blockKey(action.delta.turnId, action.delta.blockIndex);
      if (state.completedBlocks.has(key)) return state;
      if (
        action.delta.deltaId !== undefined &&
        state.activeDeltas.some((delta) => delta.deltaId === action.delta.deltaId)
      ) {
        return state;
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
      };
    }

    case "event.received": {
      const key = completeEventBlockKey(action.event);
      const completedBlocks = new Set(state.completedBlocks);
      if (key !== undefined) completedBlocks.add(key);
      const liveProjectionEnded = LIVE_PROJECTION_END_TYPES.has(action.event.type);

      return {
        events: state.events.some((event) => event.seq === action.event.seq)
          ? state.events
          : [...state.events, action.event],
        activeDeltas: liveProjectionEnded
          ? []
          : key === undefined
            ? state.activeDeltas
            : state.activeDeltas.filter(
                (delta) => blockKey(delta.turnId, delta.blockIndex) !== key,
              ),
        completedBlocks,
      };
    }
  }
}
