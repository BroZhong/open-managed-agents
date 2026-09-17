import { ApiError, BASE_URL } from "./api";
import type { SessionEvent } from "./types";

export interface SharedSession {
  id: string;
  title?: string;
  workspaceId: string;
  status: "idle" | "running" | "waiting" | "terminated";
  agent: { name: string };
  createdAt: string;
}

/** Separate request context: never read or mutate login storage or query caches. */
export function createShareAccess(shareId: string, onUnavailable?: () => void) {
  async function request(path: string): Promise<Response> {
    const response = await fetch(`${BASE_URL}${path}`, {
      headers: { "x-session-share": shareId, Accept: "application/json" },
      credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer",
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      if (body.code === "share_unavailable") onUnavailable?.();
      throw new ApiError(body.error ?? `Read failed (${response.status})`, response.status, body.code);
    }
    return response;
  }
  async function json<T>(path: string): Promise<T> { return (await request(path)).json(); }
  return { request, json };
}

export type ShareAccess = ReturnType<typeof createShareAccess>;

export async function loadSharedHistory(access: ShareAccess, sessionId: string): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  let after = 0;
  for (;;) {
    const page = await access.json<{ data: SessionEvent[]; has_more: boolean }>(
      `/v1/sessions/${encodeURIComponent(sessionId)}/events?limit=100${after ? `&after_seq=${after}` : ""}`,
    );
    events.push(...page.data);
    if (!page.has_more) return events;
    const next = page.data.at(-1)?.seq;
    if (next === undefined || next <= after) throw new Error("History could not be fully loaded. Retry.");
    after = next;
  }
}
