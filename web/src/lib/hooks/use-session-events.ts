import { useState, useEffect, useCallback, useReducer, useRef } from "react";
import type { SessionEvent } from "@/lib/types";
import {
  initialSessionEventStreamState,
  parseSessionSseFrame,
  sessionEventStreamReducer,
  sessionEventStreamUrl,
} from "@/lib/session-event-stream";

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
  const [{ events, activeDeltas }, dispatch] = useReducer(
    sessionEventStreamReducer,
    initialSessionEventStreamState,
  );
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

    dispatch({ type: "event.received", event });
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
    // into durable history or the active Delta projection. Shared by both the
    // initial connect and every reconnect,
    // so the frame-parsing lives in exactly one place. Returns when the stream
    // ends (`done`); throws on network/HTTP failure or abort.
    async function pumpSse(token: string | null) {
      // Always resume from the current anchor — the single source of truth,
      // seeded from history on first connect and advanced as events arrive.
      const sseRes = await fetch(
        sessionEventStreamUrl(BASE_URL, sessionId),
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
          const parsed = parseSessionSseFrame(frame);
          if (!parsed) continue;
          if (parsed.kind === "delta") {
            dispatch({ type: "delta.received", delta: parsed.delta });
            continue;
          }

          // Only durable events advance Last-Event-ID. Deltas have their own
          // Redis identity and never fabricate a Session sequence number.
          lastSeqRef.current = parsed.event.seq;
          addEvent(parsed.event);
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
      dispatch({ type: "history.loaded", events: historicalEvents });

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

  return { events, activeDeltas, status, isConnected, fileChange };
}
