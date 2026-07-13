import {
  useState,
  useEffect,
  useLayoutEffect,
  useCallback,
  useReducer,
  useRef,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { SessionEvent } from "@/lib/types";
import type { Session } from "@/lib/hooks/use-sessions";
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

function projectStatusIntoSessionCollection(
  value: unknown,
  sessionId: string,
  status: Session["status"],
): unknown {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const projected = projectStatusIntoSessionCollection(item, sessionId, status);
      changed ||= projected !== item;
      return projected;
    });
    return changed ? next : value;
  }
  if (!value || typeof value !== "object") return value;

  const record = value as Record<string, unknown>;
  if (record.id === sessionId && typeof record.status === "string") {
    if (record.status === "terminated") return value;
    return record.status === status ? value : { ...record, status };
  }

  let projected = value;
  for (const key of ["data", "pages"] as const) {
    if (!(key in record)) continue;
    const child = projectStatusIntoSessionCollection(record[key], sessionId, status);
    if (child !== record[key]) {
      projected = { ...(projected as Record<string, unknown>), [key]: child };
    }
  }
  return projected;
}

export function useSessionEvents(sessionId: string) {
  const queryClient = useQueryClient();
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
  // A render-time generation fence closes the gap before the previous
  // effect's passive cleanup aborts its fetch. The counter also distinguishes
  // A -> B -> A navigation, where comparing only the Session ID is unsafe.
  const generationRef = useRef({ sessionId, value: 0 });
  const [stateSessionId, setStateSessionId] = useState(sessionId);

  // Layout effects run in the commit before passive effect cleanup. Invalidate
  // the old stream in that gap without reading or mutating refs during render.
  useLayoutEffect(() => {
    if (generationRef.current.sessionId !== sessionId) {
      generationRef.current = {
        sessionId,
        value: generationRef.current.value + 1,
      };
    }
  }, [sessionId]);

  // React Router can reuse this hook instance when only :id changes. Adjust
  // the Session-scoped projection during render so no frame containing the old
  // Session's messages or token usage is ever committed under the new URL.
  if (stateSessionId !== sessionId) {
    setStateSessionId(sessionId);
    dispatch({ type: "history.loaded", events: [] });
    setStatus("idle");
    setIsConnected(false);
    setFileChange({ nonce: 0, changed: [], deleted: [] });
  }

  const projectStatus = useCallback((nextStatus: "idle" | "running") => {
    const session = queryClient.getQueryData<Session>(["sessions", sessionId]);
    if (session?.status === "terminated") return;

    const fetchingSessionQueries = queryClient.getQueryCache().findAll({
      predicate: (query) => {
        if (query.state.fetchStatus !== "fetching") return false;
        const { queryKey } = query;
        return queryKey[0] === "sessions" && (
          queryKey[1] === sessionId ||
          queryKey[1] === "all" ||
          queryKey[1] === "byAgent" ||
          queryKey[1] === "byLoop"
        );
      },
    });
    const fetchMoreQueries = fetchingSessionQueries.filter(
      (query) => query.state.fetchMeta?.fetchMore,
    );
    for (const query of fetchMoreQueries) {
      const pending = query.promise;
      if (!pending) continue;
      // Infinite-query pagination captures the old pages when it starts and
      // writes them all back with the new page. Preserve the user's request,
      // then restore the status projection after that write completes.
      void pending.then(() => {
        queryClient.setQueryData(
          query.queryKey,
          (value) => projectStatusIntoSessionCollection(
            value,
            sessionId,
            nextStatus,
          ),
        );
      }, () => undefined);
    }

    const inFlightQueries = fetchingSessionQueries.filter(
      (query) => !query.state.fetchMeta?.fetchMore,
    );
    if (inFlightQueries.length > 0) {
      void Promise.all(inFlightQueries.map((query) =>
        queryClient.cancelQueries(
          { queryKey: query.queryKey, exact: true },
          { revert: false },
        )
      )).then(() => Promise.all(inFlightQueries.map((query) =>
        queryClient.refetchQueries({
          queryKey: query.queryKey,
          exact: true,
          type: "active",
        })
      )));
    }

    setStatus(nextStatus);
    queryClient.setQueryData<Session>(["sessions", sessionId], (current) =>
      current && current.status !== "terminated"
        ? { ...current, status: nextStatus }
        : current,
    );
    queryClient.setQueriesData(
      {
        predicate: ({ queryKey }) =>
          queryKey[0] === "sessions" &&
          (
            queryKey[1] === "all" ||
            queryKey[1] === "byAgent" ||
            queryKey[1] === "byLoop"
          ),
      },
      (value) => projectStatusIntoSessionCollection(
        value,
        sessionId,
        nextStatus,
      ),
    );
  }, [queryClient, sessionId]);

  const addEvent = useCallback((event: SessionEvent) => {
    // Every id-bearing frame is a persisted Complete Event and therefore part
    // of durable history. Workspace file changes additionally refresh the file
    // tree, but must not disappear from Timeline when they arrive via SSE
    // replay (JSON history already includes the same events).
    dispatch({ type: "event.received", event });
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

    if (event.type === "session.status_running") {
      projectStatus("running");
    }
    if (event.type === "session.status_idle") {
      projectStatus("idle");
      // Backstop: refetch the tree once on turn end (no incremental hint).
      setFileChange((prev) => ({ nonce: prev.nonce + 1, changed: [], deleted: [] }));
    }
  }, [projectStatus]);

  useEffect(() => {
    if (!sessionId) return;

    const generation = generationRef.current.value;
    const isCurrentGeneration = () =>
      generationRef.current.sessionId === sessionId &&
      generationRef.current.value === generation;

    // Fresh lifecycle for this session: allow reconnects and start backoff low.
    closingRef.current = false;
    backoffRef.current = 1000;
    lastSeqRef.current = 0;

    const abortController = new AbortController();
    const { signal } = abortController;

    // Reads the SSE stream to completion, parsing frames and feeding events
    // into durable history or the active Delta projection. Shared by both the
    // initial connect and every reconnect,
    // so the frame-parsing lives in exactly one place. Returns when the stream
    // ends (`done`); throws on network/HTTP failure or abort.
    async function pumpSse(token: string | null) {
      if (!isCurrentGeneration()) return;
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
      if (signal.aborted || !isCurrentGeneration()) return;
      setIsConnected(true);
      backoffRef.current = 1000;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (signal.aborted || !isCurrentGeneration()) return;
        buffer += decoder.decode(value, { stream: true });

        // Parse SSE frames from buffer
        const frames = buffer.split("\n\n");
        // Last element might be incomplete
        buffer = frames.pop() || "";

        for (const frame of frames) {
          if (!frame.trim()) continue;
          const parsed = parseSessionSseFrame(frame);
          if (!parsed) continue;
          if (!isCurrentGeneration()) return;
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

    // Initial connect: page through full history (JSON mode) to render the
    // conversation, calculate complete usage, and seed the resume anchor.
    async function connect() {
      if (!isCurrentGeneration()) return;
      const token = localStorage.getItem(STORAGE_KEY);

      // 1. Fetch every historical event page (JSON mode). The endpoint defaults
      // to 50; stopping after the first page would under-report older usage.
      const historicalEvents: SessionEvent[] = [];
      let afterSeq: number | undefined;
      let hasMore = true;
      while (hasMore) {
        const query = new URLSearchParams({ limit: "1000" });
        if (afterSeq !== undefined) query.set("after_seq", String(afterSeq));
        const historyRes = await fetch(
          `${BASE_URL}/v1/sessions/${sessionId}/events?${query.toString()}`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/json",
            },
            signal,
          },
        );

        if (signal.aborted || !isCurrentGeneration()) return;

        if (!historyRes.ok) {
          throw new Error(`History fetch failed: ${historyRes.status}`);
        }

        const historyData = await historyRes.json();
        if (signal.aborted || !isCurrentGeneration()) return;
        const page: SessionEvent[] = historyData.data || historyData || [];
        historicalEvents.push(...page);
        hasMore = Boolean(historyData.has_more);
        if (hasMore) {
          const nextSeq = page.at(-1)?.seq;
          if (nextSeq === undefined || nextSeq === afterSeq) {
            throw new Error("History pagination did not advance");
          }
          afterSeq = nextSeq;
        }
      }
      if (signal.aborted || !isCurrentGeneration()) return;
      dispatch({ type: "history.loaded", events: historicalEvents });

      // All pages are present, so the latest lifecycle transition is safe to
      // project into both this hook and the shared Session query caches.
      for (let i = historicalEvents.length - 1; i >= 0; i--) {
        const evt = historicalEvents[i];
        if (evt.type === "session.status_running") {
          projectStatus("running");
          break;
        }
        if (evt.type === "session.status_idle") {
          projectStatus("idle");
          break;
        }
      }

      // Seed the resume anchor from the last historical event.
      lastSeqRef.current =
        historicalEvents.length > 0
          ? historicalEvents[historicalEvents.length - 1].seq
          : 0;

      // 2. Open SSE connection
      if (!isCurrentGeneration()) return;
      await pumpSse(token);
    }

    // Reconnect path: no history refetch. Reopen SSE directly at the resume
    // anchor and let the server's paginated backfill fill the gap; addEvent
    // dedupes by seq, so re-delivered events don't duplicate.
    async function connectSse() {
      if (!isCurrentGeneration()) return;
      const token = localStorage.getItem(STORAGE_KEY);
      await pumpSse(token);
    }

    // Both unexpected exits — the read loop finishing (`done`) and a thrown
    // error — funnel here. A deliberate close (cleanup flipped closingRef) or
    // an AbortError is not a drop and must not reconnect.
    function scheduleReconnect(err?: unknown) {
      if (signal.aborted || !isCurrentGeneration()) return;
      if (closingRef.current) return;
      if (err instanceof DOMException && err.name === "AbortError") return;
      setIsConnected(false);

      // Exponential backoff with ±20% jitter, capped at 30s.
      const base = backoffRef.current;
      const jitter = base * 0.2 * (Math.random() * 2 - 1);
      const delay = base + jitter;
      backoffRef.current = Math.min(base * 2, 30000);

      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        if (
          signal.aborted ||
          closingRef.current ||
          !isCurrentGeneration()
        ) return;
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
    };
  }, [sessionId, addEvent, projectStatus]);

  return { events, activeDeltas, status, isConnected, fileChange };
}
