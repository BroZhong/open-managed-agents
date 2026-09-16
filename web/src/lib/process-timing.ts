import type { DisplayMessage } from "@/lib/conversation-projection";
import { outputBlockKey } from "@/lib/output-block";
import type { SessionDelta, SessionEvent } from "@/lib/types";

export interface ProcessTiming { startedAt: number; endedAt: number }

function timestamp(value: string): number | undefined {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Wall time for each consecutive activity group, including model and tool waits.
 * Parallel tools overlap; their individual durations must never be summed. */
export function processTimings(messages: DisplayMessage[], events: SessionEvent[], deltas: SessionDelta[]): Map<string, ProcessTiming> {
  const indices = new Map(events.map((event, index) => [event.seq, index]));
  const deltaTimes = new Map<string, number>();
  for (const delta of deltas) {
    const time = timestamp(delta.ts);
    if (time === undefined) continue;
    const data = delta.data as { toolUseId?: string };
    const id = delta.type.startsWith("agent.thinking") ? `thinking-${outputBlockKey(delta)}`
      : delta.type.startsWith("agent.message") ? `assistant-${outputBlockKey(delta)}`
        : data.toolUseId ? `tool-${delta.turnId}:${data.toolUseId}` : undefined;
    if (id && !deltaTimes.has(id)) deltaTimes.set(id, time);
  }
  const messageTime = (message: DisplayMessage | undefined) => {
    if (!message) return undefined;
    const index = message.seq === undefined ? undefined : indices.get(message.seq);
    return index === undefined ? deltaTimes.get(message.id) : timestamp(events[index].ts);
  };
  const activity = (message: DisplayMessage | undefined) => message?.role === "thinking" || message?.role === "tool_use";
  const result = new Map<string, ProcessTiming>();
  for (let i = 0; i < messages.length; i++) {
    if (!activity(messages[i])) continue;
    const first = messages[i];
    const previous = messages[i - 1];
    while (activity(messages[i + 1])) i++;
    const last = messages[i];
    const next = messages[i + 1];
    const firstIndex = first.seq === undefined ? events.length : indices.get(first.seq) ?? events.length;
    const previousIndex = previous?.seq === undefined ? previous ? events.length - 1 : -1 : indices.get(previous.seq) ?? -1;
    const nextIndex = next?.seq === undefined ? events.length : indices.get(next.seq) ?? events.length;
    let startedAt = messageTime(first);
    // Recover the request/Turn start when thinking was only persisted on completion.
    // Do not include time spent queued before the Turn started, or idle between Turns.
    for (let j = previousIndex + 1; j < firstIndex; j++) {
      const event = events[j];
      if (/^session\.(status_idle|turn_completed|turn_aborted|error)$/.test(event.type)) startedAt = messageTime(first);
      if (event.type === "session.status_running" || event.type === "span.model_request_start") {
        const time = timestamp(event.ts);
        if (time !== undefined) startedAt = Math.min(startedAt ?? time, time);
      }
    }
    if (startedAt === undefined) continue;
    // A text block ends this activity group. Otherwise freeze at its last
    // recorded event (including tool results and a terminal lifecycle event).
    let endedAt = messageTime(last) ?? startedAt;
    let terminated = false;
    const textBoundary = next && next.role !== "user" ? messageTime(next) : undefined;
    for (let j = firstIndex; j < nextIndex; j++) {
      const event = events[j];
      const time = timestamp(event.ts);
      if (time !== undefined) endedAt = Math.max(endedAt, time);
      if (/^session\.(status_idle|turn_completed|turn_aborted|error)$/.test(event.type)) { terminated = true; break; }
    }
    if (!terminated && textBoundary !== undefined) endedAt = Math.max(endedAt, textBoundary);
    result.set(first.id, { startedAt, endedAt });
  }
  return result;
}

export function formatElapsedTime(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours}h ${minutes % 60}m ${seconds % 60}s` : minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}
