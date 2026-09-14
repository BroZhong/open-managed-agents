import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";

export interface QueuedInputEntry {
  /** The Host's pending-event id. */
  id: string;
  type: string;
  data: unknown;
  arrivedAt: string;
}

interface QueuedInputResponse {
  count: number;
  has_more?: boolean;
  data: Array<{ id: string; type: string; data: unknown; arrived_at: string }>;
}

export interface QueuedInputState {
  /** Queued Input the Host reports, oldest first. */
  entries: QueuedInputEntry[];
  /** Whether more Queued Input exists beyond `entries` (bounded preview). */
  hasMore: boolean;
}

const EMPTY: QueuedInputState = { entries: [], hasMore: false };

/**
 * The Session's Queued Input, read from the Host (issue #114).
 *
 * Whether anything is waiting to run is a *server* fact. Deriving it from the
 * console's own optimistic sends broke twice over: the hint vanished in the gap
 * between one Turn ending and the next starting (an Interrupt makes that gap
 * easy to hit), and it was lost entirely on reload because it lived only in
 * component state.
 *
 * `revalidate` changes whenever the Session's Turn lifecycle moves, so the
 * queue is re-read at exactly the moments it can have changed — a Turn starting
 * claims an entry, a Turn ending may start the next one. A successful send also
 * invalidates this Session's queue. The slow poll is a backstop for changes from
 * another client or replica whose lifecycle events this client may not see.
 */
export function useQueuedInput(
  sessionId: string,
  revalidate: number,
): QueuedInputState {
  const { data } = useQuery({
    queryKey: ["sessions", sessionId, "pending", revalidate],
    queryFn: async ({ signal }): Promise<QueuedInputState> => {
      const res = await apiFetch<QueuedInputResponse>(
        `/v1/sessions/${sessionId}/pending`,
        { signal },
      );
      return {
        entries: (res.data ?? []).map((event) => ({
          id: event.id,
          type: event.type,
          data: event.data,
          arrivedAt: event.arrived_at,
        })),
        hasMore: res.has_more ?? false,
      };
    },
    enabled: Boolean(sessionId),
    // The queue is a live fact, not a cacheable read: an entry the user just
    // sent must not be served from a stale window.
    staleTime: 0,
    refetchInterval: 15_000,
    // Keep the last known queue through lifecycle refetches within a Session,
    // but never carry another Session's entries across a navigation.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === sessionId ? previous : undefined,
  });

  return data ?? EMPTY;
}
