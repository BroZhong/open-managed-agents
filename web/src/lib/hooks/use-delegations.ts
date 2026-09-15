import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { executionActive, executionPath, type DelegationList, type ExecutionTrace } from "@/lib/delegations";
import { initialSessionEventStreamState, sessionEventStreamReducer } from "@/lib/session-event-stream";

export function useToolDelegation(sessionId: string, toolUseId: string, turnId?: string, hasResult = false) {
  const query = new URLSearchParams({ tool_use_id: toolUseId, limit: "1" });
  if (turnId) query.set("turn_id", turnId);
  return useQuery({
    queryKey: ["delegation-tool", sessionId, turnId, toolUseId],
    queryFn: ({ signal }) => apiFetch<DelegationList>(`/v1/sessions/${encodeURIComponent(sessionId)}/delegations?${query}`, { signal }),
    enabled: !!sessionId && !!toolUseId,
    refetchInterval: (query) => {
      const execution = query.state.data?.data[0];
      return query.state.error ? false : execution ? executionActive(execution.status) ? 2000 : false : hasResult ? false : 2000;
    },
  });
}
export function useDelegations(sessionId: string, origin = false) {
  return useInfiniteQuery({
    queryKey: ["delegations", sessionId, origin],
    initialPageParam: "",
    queryFn: ({ pageParam, signal }) => apiFetch<DelegationList>(
      `/v1/sessions/${encodeURIComponent(sessionId)}/${origin ? "delegation-origin" : "delegations"}?limit=20${pageParam ? `&after_id=${encodeURIComponent(pageParam)}` : ""}`, { signal }),
    getNextPageParam: (page) => page.has_more ? page.next_cursor : undefined,
    refetchInterval: 3000,
    enabled: !!sessionId,
  });
}

/** A scoped observer: one bounded page per request, independently of the parent Turn.
 * Reconnect resumes at the last durable sequence. Delta snapshots never become history.
 */
export function useExecutionTrace(sessionId: string, executionId: string) {
  const queryClient = useQueryClient();
  const [projection, dispatch] = useReducer(sessionEventStreamReducer, initialSessionEventStreamState);
  const [trace, setTrace] = useState<ExecutionTrace>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const refresh = useRef<() => void>(() => {});
  const identity = `${sessionId}:${executionId}`;
  const [stateIdentity, setStateIdentity] = useState(identity);
  if (stateIdentity !== identity) {
    setStateIdentity(identity);
    dispatch({ type: "history.loaded", events: [] });
    setTrace(undefined);
    setLoading(true);
    setError(undefined);
  }

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cursor = 0;
    let fetching = false;
    let current: ExecutionTrace | undefined;
    async function read() {
      if (fetching || controller.signal.aborted) return;
      fetching = true;
      clearTimeout(timer);
      setLoading(true);
      try {
        const page = await apiFetch<ExecutionTrace>(`${executionPath(sessionId, executionId)}?limit=50&after_seq=${cursor}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        for (const event of page.data) dispatch({ type: "event.received", event });
        // Replace the transient snapshot on every successful read, including after a reconnect.
        dispatch({ type: "deltas.loaded", deltas: page.deltas });
        cursor = page.next_cursor ?? cursor;
        if (current?.execution.status !== page.execution.status) {
          // An execution can finish after its parent. Re-read current Session
          // status instead of deriving it from a historical execution (a later
          // resume may already be running in the same child Session).
          void queryClient.invalidateQueries({ queryKey: ["sessions"] });
        }
        current = page;
        setTrace(page);
        setError(undefined);
      } catch (error) {
        if (controller.signal.aborted) return;
        setError(error instanceof Error ? error.message : "Trace unavailable");
      } finally {
        fetching = false;
        if (!controller.signal.aborted) {
          setLoading(false);
          // Backlog is explicitly user-paged. Never drain an entire child history.
          if (!current?.has_more && (!current || executionActive(current.execution.status))) {
            timer = setTimeout(() => void read(), 2000);
          }
        }
      }
    }
    refresh.current = () => void read();
    void read();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [sessionId, executionId, queryClient]);
  const retry = useCallback(() => refresh.current(), []);
  return { ...projection, trace, loading, error, retry, loadMore: retry };
}
