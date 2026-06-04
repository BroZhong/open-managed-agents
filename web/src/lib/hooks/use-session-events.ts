import { useState, useEffect, useCallback, useRef } from "react";
import type { SessionEvent } from "@/lib/types";

const BASE_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3000";
const STORAGE_KEY = "oma_api_key";

export function useSessionEvents(sessionId: string) {
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [status, setStatus] = useState<"idle" | "running">("idle");
  const [isConnected, setIsConnected] = useState(false);
  const eventsRef = useRef(events);
  eventsRef.current = events;

  const addEvent = useCallback((event: SessionEvent) => {
    setEvents((prev) => {
      if (prev.some((e) => e.seq === event.seq)) return prev;
      return [...prev, event];
    });
    if (event.type === "session.status_running") setStatus("running");
    if (event.type === "session.status_idle") setStatus("idle");
  }, []);

  useEffect(() => {
    if (!sessionId) return;

    const abortController = new AbortController();
    const { signal } = abortController;

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

      // Determine last seq for SSE resume
      const lastSeq =
        historicalEvents.length > 0
          ? historicalEvents[historicalEvents.length - 1].seq
          : 0;

      // 2. Open SSE connection
      const sseRes = await fetch(
        `${BASE_URL}/v1/sessions/${sessionId}/events`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "text/event-stream",
            "Last-Event-ID": String(lastSeq),
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
      setIsConnected(true);

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

          const lines = frame.split("\n");
          for (const line of lines) {
            if (line.startsWith("id: ")) {
              eventId = line.slice(4);
            } else if (line.startsWith("event: ")) {
              eventType = line.slice(7);
            } else if (line.startsWith("data: ")) {
              dataLines.push(line.slice(6));
            } else if (line.startsWith("data:")) {
              dataLines.push(line.slice(5));
            }
          }

          if (dataLines.length === 0) continue;

          const dataStr = dataLines.join("\n");
          try {
            const parsed = JSON.parse(dataStr);
            const event: SessionEvent = {
              seq: eventId ? parseInt(eventId, 10) : 0,
              type: eventType || parsed.type || "",
              data: parsed.data ?? parsed,
              ts: parsed.ts || new Date().toISOString(),
            };
            addEvent(event);
          } catch {
            // Skip unparseable frames
          }
        }
      }
    }

    connect().catch(() => {
      setIsConnected(false);
    });

    return () => {
      abortController.abort();
      setIsConnected(false);
    };
  }, [sessionId, addEvent]);

  return { events, status, isConnected };
}
