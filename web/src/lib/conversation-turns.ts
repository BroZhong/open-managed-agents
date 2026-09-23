import type { DisplayMessage } from "./conversation-projection";
import type { ProcessTiming } from "./process-timing";
import type { SessionEvent } from "./types";

export interface ConversationTurn {
  id: string;
  turnId?: string;
  userMessage: DisplayMessage | null;
  responses: DisplayMessage[];
  timing?: ProcessTiming;
  completed: boolean;
  running: boolean;
}

/** Input promotion, including a claimed Delegation Result, starts a Turn.
 * Notification arrival alone never starts model execution. Legacy logs can
 * still use lifecycle boundaries when their output has no turnId. */
export function groupMessagesIntoTurns(messages: DisplayMessage[], events: SessionEvent[], sessionStatus: "idle" | "running" | "waiting" | "terminated"): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  const bySeq = new Map(messages.filter((message) => message.seq !== undefined).map((message) => [message.seq, message]));
  let current: ConversationTurn | undefined;
  let closed = false;
  let stopped = false;
  let executionStarted = false;

  function begin(id: string) {
    // A later input also establishes the previous Turn's end in legacy logs.
    if (current && !closed) current.completed = !stopped;
    current = { id, userMessage: null, responses: [], completed: false, running: false };
    turns.push(current);
    closed = false;
    stopped = false;
    executionStarted = false;
    return current;
  }

  for (const event of events) {
    const message = bySeq.get(event.seq);
    const input = ["user.message", "delegation.input", "subagent.result_claimed"].includes(event.type);
    const turnId = (event.data as { turnId?: string }).turnId;
    if (input) begin(`input-${event.seq}`);
    else if (message || event.type === "session.status_running" || event.type === "span.model_request_start") {
      if (!current || closed || (turnId && current.turnId && turnId !== current.turnId)) begin(`turn-${turnId ?? event.seq}`);
    }
    if (!current) continue;
    // Late lifecycle records from another execution must not close this Turn.
    if (turnId && current.turnId && turnId !== current.turnId) continue;
    if (turnId) current.turnId = turnId;
    const time = Date.parse(event.ts);
    if (Number.isFinite(time) && !closed) {
      current.timing ??= { startedAt: time, endedAt: time };
      if (event.type === "session.status_running" && !executionStarted) {
        current.timing.startedAt = time;
        executionStarted = true;
      }
      current.timing.endedAt = Math.max(current.timing.endedAt, time);
    }
    if (message?.role === "user") current.userMessage = message;
    else if (message) current.responses.push(message);
    if (event.type === "session.error" || event.type === "session.turn_aborted" || message?.aborted) stopped = true;
    if (event.type === "session.turn_completed" || event.type === "session.status_idle") {
      // Turn completion owns its timing. A later Session idle event must not
      // extend it; idle remains a fallback for historical logs.
      if ((!closed || event.type === "session.turn_completed") && Number.isFinite(time) && current.timing) current.timing.endedAt = Math.max(current.timing.endedAt, time);
      current.completed = !stopped;
      closed = true;
    }
    if (stopped) current.completed = false;
  }

  for (const message of messages.filter((message) => message.seq === undefined)) {
    if (!current || closed || (message.turnId && current.turnId && message.turnId !== current.turnId)) current = begin(`turn-${message.turnId ?? message.id}`);
    current.turnId ??= message.turnId;
    current.responses.push(message);
  }
  if (current && !closed) {
    current.running = sessionStatus !== "idle";
    // Older persisted logs may not contain terminal lifecycle records.
    current.completed = !stopped && sessionStatus === "idle";
  }
  return turns.filter((turn) => turn.userMessage || turn.responses.length);
}
