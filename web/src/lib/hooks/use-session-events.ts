import { useState, useEffect, useCallback, useRef } from "react";
import type { SessionEvent } from "@/lib/types";

const BASE_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3000";
const STORAGE_KEY = "oma_api_key";

export interface WorkspaceFileChange {
  /** Monotonic counter — bumped on every workspace.file_change event or turn end. */
  nonce: number;
  /** Incremental hint from the Host, when the event carries one (may be empty). */
  changed: string[];
  deleted: string[];
}

export function useSessionEvents(sessionId: string) {
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [status, setStatus] = useState<"idle" | "running">("idle");
  const [isConnected, setIsConnected] = useState(false);
  // Signals the Workspace panel to refresh its tree. Driven by the Host's
  // `workspace.file_change` SSE event (incremental) and by turn end
  // (session.status_idle) as a backstop. Consumed defensively — works even if
  // #43 has not yet emitted the file-change event.
  const [fileChange, setFileChange] = useState<WorkspaceFileChange>({
    nonce: 0,
    changed: [],
    deleted: [],
  });
  const eventsRef = useRef(events);
  eventsRef.current = events;

  // Reconnect anchor: the last seq we've received. Seeded from history on the
  // first connect, then advanced as each event with a real seq arrives. On a
  // reconnect we replay it as `Last-Event-ID` so the server's paginated
  // backfill (#95) fills the gap — no history refetch, no lost events.
  const lastSeqRef = useRef(0);
  // Distinguishes a deliberate teardown (unmount / session switch) from an
  // unexpected drop. The effect cleanup flips this true; the reconnect logic
  // refuses to reschedule once it's set, so a stale connect can't resurrect a
  // torn-down stream.
  const closingRef = useRef(false);
  // Pending reconnect timer, cleared on cleanup so no ghost reconnect fires
  // after unmount.
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Current backoff interval (ms): starts at 1s, doubles per failure, caps at
  // 30s, resets to 1s once a connection is successfully established.
  const backoffRef = useRef(1000);

  const addEvent = useCallback((event: SessionEvent) => {
    // Workspace file-change events are transient signals, not part of the
    // conversation/timeline event list — route them to the refresh channel.
    if (event.type === "workspace.file_change") {
      const data = (event.data ?? {}) as { changed?: unknown; deleted?: unknown };
      const changed = Array.isArray(data.changed)
        ? data.changed.filter((x): x is string => typeof x === "string")
        : [];
      const deleted = Array.isArray(data.deleted)
        ? data.deleted.filter((x): x is string => typeof x === "string")
        : [];
      setFileChange((prev) => ({ nonce: prev.nonce + 1, changed, deleted }));
      return;
    }

    setEvents((prev) => {
      if (prev.some((e) => e.seq === event.seq)) return prev;
      return [...prev, event];
    });
    if (event.type === "session.status_running") setStatus("running");
    if (event.type === "session.status_idle") {
      setStatus("idle");
      // Backstop: refetch the tree once on turn end (no incremental hint).
      setFileChange((prev) => ({ nonce: prev.nonce + 1, changed: [], deleted: [] }));
    }
  }, []);

  useEffect(() => {
    if (!sessionId) return;

    // Fresh lifecycle for this session: allow reconnects and start backoff low.
    closingRef.current = false;
    backoffRef.current = 1000;

    const abortController = new AbortController();
    const { signal } = abortController;

    // Reads the SSE stream to completion, parsing frames and feeding events
    // into `addEvent`. Shared by both the initial connect and every reconnect,
    // so the frame-parsing lives in exactly one place. Returns when the stream
    // ends (`done`); throws on network/HTTP failure or abort.
    async function pumpSse(token: string | null) {
      // Always resume from the current anchor — the single source of truth,
      // seeded from history on first connect and advanced as events arrive.
      const sseRes = await fetch(
        `${BASE_URL}/v1/sessions/${sessionId}/events`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "text/event-stream",
            "Last-Event-ID": String(lastSeqRef.current),
          },
          signal,
        },
      );

      if (!sseRes.ok) {
        throw new Error(`SSE connection failed: ${sseRes.status}`);
      }

      const reader = sseRes.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      // A live stream: mark connected and reset backoff so the next drop
      // starts its wait fresh from 1s rather than wherever we'd climbed to.
      setIsConnected(true);
      backoffRef.current = 1000;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Parse SSE frames from buffer
        const frames = buffer.split("\n\n");
        // Last element might be incomplete
        buffer = frames.pop() || "";

        for (const frame of frames) {
          if (!frame.trim()) continue;

          let eventId = "";
          let eventType = "";
          const dataLines: string[] = [];

          // Parse SSE fields per spec: "field: value" or "field:value" (the
          // single optional leading space is stripped either way).
          const lines = frame.split("\n");
          for (const line of lines) {
            const stripField = (field: string): string | undefined => {
              if (!line.startsWith(field + ":")) return undefined;
              const rest = line.slice(field.length + 1);
              return rest.startsWith(" ") ? rest.slice(1) : rest;
            };
            const id = stripField("id");
            const evt = stripField("event");
            const data = stripField("data");
            if (id !== undefined) eventId = id;
            else if (evt !== undefined) eventType = evt;
            else if (data !== undefined) dataLines.push(data);
          }

          if (dataLines.length === 0) continue;

          // Every persisted event on this stream carries id:<seq> (#71). A frame
          // without an id is not a resumable persisted event — dropping it (vs.
          // forcing seq 0) avoids a phantom duplicate keyed at 0 and keeps the
          // Last-Event-ID resume anchored to a real seq.
          if (eventId === "") continue;

          const dataStr = dataLines.join("\n");
          try {
            const parsed = JSON.parse(dataStr);
            const seq = parseInt(eventId, 10);
            const event: SessionEvent = {
              seq,
              type: eventType || parsed.type || "",
              data: parsed.data ?? parsed,
              ts: parsed.ts || new Date().toISOString(),
            };
            // Advance the resume anchor as real events arrive so a later
            // reconnect asks the server for exactly what we've missed.
            if (Number.isFinite(seq)) lastSeqRef.current = seq;
            addEvent(event);
          } catch {
            // Skip unparseable frames
          }
        }
      }
    }

    // Initial connect: load full history (JSON mode) to render past
    // conversation, seed the resume anchor, then open the live SSE.
    async function connect() {
      const token = localStorage.getItem(STORAGE_KEY);

      // 1. Fetch historical events (JSON mode)
      const historyRes = await fetch(
        `${BASE_URL}/v1/sessions/${sessionId}/events`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
          },
          signal,
        },
      );

      if (!historyRes.ok) {
        throw new Error(`History fetch failed: ${historyRes.status}`);
      }

      const historyData = await historyRes.json();
      const historicalEvents: SessionEvent[] =
        historyData.data || historyData || [];
      setEvents(historicalEvents);

      // Derive status from historical events
      for (let i = historicalEvents.length - 1; i >= 0; i--) {
        const evt = historicalEvents[i];
        if (evt.type === "session.status_running") {
          setStatus("running");
          break;
        }
        if (evt.type === "session.status_idle") {
          setStatus("idle");
          break;
        }
      }

      // Seed the resume anchor from the last historical event.
      lastSeqRef.current =
        historicalEvents.length > 0
          ? historicalEvents[historicalEvents.length - 1].seq
          : 0;

      // 2. Open SSE connection
      await pumpSse(token);
    }

    // Reconnect path: no history refetch. Reopen SSE directly at the resume
    // anchor and let the server's paginated backfill fill the gap; addEvent
    // dedupes by seq, so re-delivered events don't duplicate.
    async function connectSse() {
      const token = localStorage.getItem(STORAGE_KEY);
      await pumpSse(token);
    }

    // Both unexpected exits — the read loop finishing (`done`) and a thrown
    // error — funnel here. A deliberate close (cleanup flipped closingRef) or
    // an AbortError is not a drop and must not reconnect.
    function scheduleReconnect(err?: unknown) {
      setIsConnected(false);
      if (closingRef.current) return;
      if (err instanceof DOMException && err.name === "AbortError") return;

      // Exponential backoff with ±20% jitter, capped at 30s.
      const base = backoffRef.current;
      const jitter = base * 0.2 * (Math.random() * 2 - 1);
      const delay = base + jitter;
      backoffRef.current = Math.min(base * 2, 30000);

      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        if (closingRef.current) return;
        connectSse().then(scheduleReconnect, scheduleReconnect);
      }, delay);
    }

    // A clean `done` (stream ended) resolves; an error rejects. Route both
    // through scheduleReconnect, which decides whether the exit was deliberate.
    connect().then(scheduleReconnect, scheduleReconnect);

    return () => {
      // Deliberate teardown: stop reconnecting, kill any pending timer, and
      // abort the in-flight fetch so no ghost stream survives the switch.
      closingRef.current = true;
      if (reconnectTimerRef.current !== null) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      abortController.abort();
      setIsConnected(false);
    };
  }, [sessionId, addEvent]);

  return { events, status, isConnected, fileChange };
}
