import { Hono } from "hono";
import type { EventLogIngressStore, PendingEventIngressStore, SessionStore } from "@oma-server/store";
import type { EventStreamHub } from "@oma-server/event-log";
import { alignedChunkData } from "@oma-server/event-log";
import type { TurnStreamStore } from "@oma-server/redis";
import type { SessionRouter } from "@oma-server/session-router";
import type { TenantContext } from "../types.js";
import { deriveTitleFromEventData } from "../lib/derive-title.js";

type Env = {
  Variables: {
    tenant: TenantContext;
  };
};

// Keep this comfortably below common load-balancer idle timeouts. SSE comments
// produce transport activity without dispatching a browser MessageEvent or
// changing Last-Event-ID.
const DEFAULT_SSE_HEARTBEAT_INTERVAL_MS = 10_000;

export interface EventRouteDeps {
  eventLogStore: EventLogIngressStore;
  pendingEventStore: PendingEventIngressStore;
  sessionStore: SessionStore;
  eventStreamHub?: EventStreamHub;
  sessionRouter?: SessionRouter;
  /**
   * Transient per-turn delta stream + active-turn map (Redis). When present,
   * the SSE reconnect merge is done server-side: completed Events are replayed
   * from PostgreSQL, then the active turn's Redis deltas are appended, then the
   * connection goes live — the client sees one seamless stream.
   */
  turnStreamStore?: TurnStreamStore;
  /** Override the SSE keepalive cadence in focused tests. */
  sseHeartbeatIntervalMs?: number;
}

const ALLOWED_USER_TYPES = [
  "user.message",
  "user.interrupt",
  "user.tool_confirmation",
  "user.custom_tool_result",
  "user.define_outcome",
] as const;

type AllowedUserType = (typeof ALLOWED_USER_TYPES)[number];

type IncomingUserEvent = {
  type: AllowedUserType;
  data: unknown;
};

const PENDING_USER_TYPES = new Set<AllowedUserType>([
  "user.message",
  "user.tool_confirmation",
  "user.custom_tool_result",
]);

export function eventRoutes(deps: EventRouteDeps) {
  const router = new Hono<Env>();

  // POST /v1/sessions/:id/events — Append user events
  router.post("/v1/sessions/:id/events", async (c) => {
    const sessionId = c.req.param("id");
    const tenant = c.get("tenant");

    // Validate session exists and belongs to tenant
    const session = await deps.sessionStore.getById(sessionId);
    if (!session || session.tenantId !== tenant.tenantId) {
      return c.json({ error: "Session not found" }, 404);
    }
    if (session.status === "terminated") {
      return c.json({ error: "Session is terminated" }, 410);
    }

    const body = await c.req.json().catch(() => null);
    if (!body || !Array.isArray(body.events)) {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (body.events.length === 0) {
      return c.json({ error: "events must not be empty" }, 400);
    }

    // Validate the complete batch before any title, queue, log, or interrupt
    // side effect. A client may safely correct/retry a rejected batch without
    // duplicating a prefix that the server had already accepted.
    const events: IncomingUserEvent[] = [];
    for (const candidate of body.events) {
      const type = candidate && typeof candidate === "object"
        ? (candidate as { type?: unknown }).type
        : undefined;
      if (typeof type !== "string" || !ALLOWED_USER_TYPES.includes(type as AllowedUserType)) {
        return c.json({ error: `Unsupported event type: ${String(type)}` }, 400);
      }
      events.push({
        type: type as AllowedUserType,
        data: (candidate as { data?: unknown }).data,
      });
    }

    const interrupt = events.find((event) => event.type === "user.interrupt");
    if (interrupt) {
      if (events.length !== 1) {
        return c.json({ error: "user.interrupt must be the only event in a batch" }, 400);
      }
      deps.sessionRouter?.interrupt(sessionId);
      return c.json({ accepted: true, interrupted: true }, 202);
    }

    const pendingEvents = events.filter((event) => PENDING_USER_TYPES.has(event.type));
    const directEvents = events.filter((event) => !PENDING_USER_TYPES.has(event.type));
    if (pendingEvents.length > 0 && directEvents.length > 0) {
      return c.json({ error: "Queued and direct events cannot share one batch" }, 400);
    }
    // Direct events do not share the pending-input transaction. Keep their
    // existing semantics explicit and single-event so a request can never be
    // partially committed.
    if (directEvents.length > 1) {
      return c.json({ error: "Direct events must be submitted one at a time" }, 400);
    }

    let acceptedPending = false;
    if (pendingEvents.length > 0) {
      const inserted = await deps.pendingEventStore.enqueueBatchIfSessionActive(
        sessionId,
        pendingEvents.map(({ type, data }) => ({
          type,
          data,
          sessionThreadId: "sthr_primary",
        })),
      );
      if (!inserted) {
        return c.json({ error: "Session is terminated" }, 410);
      }
      acceptedPending = true;
    }

    // Snapshot a title from the FIRST user.message in this batch, but only if the
    // Session has no title yet — so later messages never overwrite it (#70). We
    // track it locally too, so a batch carrying multiple messages still titles
    // from the first one. This is the path real clients take (the frontend sends
    // messages via /events, not /messages).
    let titleAlreadyHandled = Boolean(session.title);

    for (const event of events) {
      const { type, data } = event;

      // Derive + store the Session title from the first user.message's text
      // (once, never overwritten). Best-effort: a store failure must never block
      // message send, so it is swallowed.
      if (type === "user.message" && !titleAlreadyHandled) {
        const derived = deriveTitleFromEventData(data);
        if (derived) {
          titleAlreadyHandled = true;
          try {
            await deps.sessionStore.setTitle(sessionId, derived);
          } catch {
            // ignore — titling is non-essential
          }
        }
      }

      if (!PENDING_USER_TYPES.has(type)) {
        // Non-pending events (user.define_outcome) go directly to canonical log
        const appended = await deps.eventLogStore.appendIfSessionActive(sessionId, {
          type,
          data,
          sessionThreadId: "sthr_primary",
        });
        if (!appended) {
          return c.json({ error: "Session is terminated" }, 410);
        }
      }
    }

    // Trigger session router if we enqueued pending events
    if (acceptedPending && deps.sessionRouter) {
      void deps.sessionRouter.handleNewEvent(sessionId, session.agent).catch((error) => {
        // The input is already durable in the Pending Event Store. Keep the
        // request accepted and leave recovery/retry to the router lifecycle.
        console.error(`SessionRouter failed after accepting input for ${sessionId}:`, error);
      });
    }

    return c.body(null, 202);
  });

  // GET /v1/sessions/:id/events — List events or SSE stream
  router.get("/v1/sessions/:id/events", async (c) => {
    const sessionId = c.req.param("id");
    const tenant = c.get("tenant");

    // Validate session exists and belongs to tenant
    const session = await deps.sessionStore.getById(sessionId);
    if (!session || session.tenantId !== tenant.tenantId) {
      return c.json({ error: "Session not found" }, 404);
    }

    const accept = c.req.header("accept") ?? "";

    // SSE streaming mode
    if (accept === "text/event-stream" && deps.eventStreamHub) {
      const replayParam = c.req.query("replay");
      const lastEventId = c.req.header("last-event-id");
      // Delta backfill is always on for the active turn so the client sees one
      // seamless stream; `include=chunks` additionally forwards live deltas.
      const includeChunks = c.req.query("include") === "chunks";

      const shouldReplay = replayParam === "1" || lastEventId !== undefined;

      // Subscribe to the live hub BEFORE any backfill so no live event is lost
      // during the (async) PostgreSQL + Redis replay.
      const { stream: liveStream, unsubscribe } = deps.eventStreamHub.subscribe(
        sessionId,
        { includeChunks },
      );

      const turnStreamStore = deps.turnStreamStore;
      const heartbeatIntervalMs = Math.max(
        1,
        deps.sseHeartbeatIntervalMs ?? DEFAULT_SSE_HEARTBEAT_INTERVAL_MS,
      );
      let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
      let liveReader: ReadableStreamDefaultReader<string> | undefined;
      let responseClosed = false;
      let cleanupStarted = false;

      // Cancellation can race with async PG/Redis replay, the heartbeat timer,
      // and a pending hub read. Make every exit converge on one idempotent
      // cleanup path so no timer writes to a closed response controller.
      const cleanup = () => {
        if (cleanupStarted) return;
        cleanupStarted = true;

        if (heartbeatTimer !== undefined) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = undefined;
        }

        const reader = liveReader;
        liveReader = undefined;
        if (reader) {
          void reader.cancel().catch(() => {});
        }
        unsubscribe();
      };

      const responseStream = new ReadableStream<string>({
        start: async (controller) => {
          try {
            const enqueue = (frame: string): boolean => {
              if (responseClosed) return false;
              try {
                controller.enqueue(frame);
                return true;
              } catch {
                // The downstream response closed between our state check and
                // enqueue. Stop all producers; cancellation is not an error.
                responseClosed = true;
                cleanup();
                return false;
              }
            };

            // Send retry directive as the first frame, then a comment while the
            // stream is otherwise idle. The timer starts before replay so a
            // slow PG/Redis backfill is protected too.
            if (!enqueue("retry: 1000\n\n")) return;
            heartbeatTimer = setInterval(() => {
              enqueue(": keepalive\n\n");
            }, heartbeatIntervalMs);

            // Highest Redis stream entry id backfilled per turn. A live delta
            // whose entry id is <= this was already emitted by the backfill, so
            // it is skipped — de-overlapping the narrow window between subscribing
            // to the hub and snapshotting Redis. Keyed by turnId.
            const maxBackfilledIdForTurn = new Map<string, string>();

            // Replay completed events + active-turn deltas server-side.
            if (shouldReplay) {
              let afterSeq: number | undefined;
              if (lastEventId) {
                const parsed = parseInt(lastEventId, 10);
                if (!isNaN(parsed)) {
                  afterSeq = parsed;
                }
              }

              // 1. Completed Events from PostgreSQL (authoritative log). Page
              //    until hasMore is false so a resume after >1 batch of queued
              //    events backfills ALL of them — never just the first page.
              let cursorSeq = afterSeq;
              let hasMore = true;
              while (hasMore) {
                const result = await deps.eventLogStore.getEvents(sessionId, {
                  afterSeq: cursorSeq,
                  limit: 1000,
                });
                if (responseClosed) return;

                for (const event of result.data) {
                  let frame = `event: ${event.type}\n`;
                  frame += `id: ${event.seq}\n`;
                  frame += `data: ${JSON.stringify(event.data)}\n\n`;
                  if (!enqueue(frame)) return;
                  cursorSeq = event.seq;
                }

                hasMore = result.hasMore;
              }

              // 2. Active turn's half-emitted deltas from Redis (if a turn is
              //    still running). Once a turn ends its stream is reclaimed and
              //    the full content already came from PostgreSQL above, so there
              //    is nothing (and nothing needed) to backfill.
              if (turnStreamStore) {
                const active = await turnStreamStore.getActiveTurn(sessionId);
                if (responseClosed) return;
                if (active && active.status === "running") {
                  const deltas = await turnStreamStore.readDeltas(active.turnId);
                  if (responseClosed) return;
                  for (const delta of deltas) {
                    const data = alignedChunkData({
                      data: delta.data,
                      turnId: delta.turnId,
                      blockIndex: delta.blockIndex,
                      deltaId: delta.id,
                    });
                    if (!enqueue(
                      `event: ${delta.type}\ndata: ${JSON.stringify(data)}\n\n`,
                    )) return;
                  }
                  if (deltas.length > 0) {
                    maxBackfilledIdForTurn.set(active.turnId, deltas[deltas.length - 1].id);
                  }
                }
              }
            }

            // Pipe live events from hub subscription, dropping delta frames that
            // were already covered by the Redis backfill.
            if (responseClosed) return;
            liveReader = liveStream.getReader();
            while (!responseClosed) {
              const { value, done } = await liveReader.read();
              if (done) break;
              if (shouldReplay && maxBackfilledIdForTurn.size > 0) {
                if (isBackfilledDelta(value, maxBackfilledIdForTurn)) continue;
              }
              if (!enqueue(value)) break;
            }
          } catch (error) {
            if (!responseClosed) {
              responseClosed = true;
              cleanup();
              try {
                controller.error(error);
              } catch {
                // Response was cancelled while the async failure surfaced.
              }
            }
          } finally {
            const shouldCloseController = !responseClosed;
            responseClosed = true;
            cleanup();
            if (shouldCloseController) {
              try {
                controller.close();
              } catch {
                // Downstream cancellation won the race.
              }
            }
          }
        },
        cancel: () => {
          responseClosed = true;
          cleanup();
        },
      });

      // Convert string stream to Uint8Array stream for Response
      const encoder = new TextEncoder();
      const byteStream = responseStream.pipeThrough(
        new TransformStream<string, Uint8Array>({
          transform(chunk, controller) {
            controller.enqueue(encoder.encode(chunk));
          },
        }),
      );

      return new Response(byteStream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-transform",
          "connection": "keep-alive",
          "x-accel-buffering": "no",
        },
      });
    }

    // JSON response mode (default)
    const afterSeqParam = c.req.query("after_seq");
    const limitParam = c.req.query("limit");

    let afterSeq: number | undefined;
    if (afterSeqParam) {
      const parsed = parseInt(afterSeqParam, 10);
      if (!isNaN(parsed)) {
        afterSeq = parsed;
      }
    }

    let limit = 50;
    if (limitParam) {
      const parsed = parseInt(limitParam, 10);
      if (!isNaN(parsed) && parsed > 0) {
        limit = parsed;
      }
    }

    const result = await deps.eventLogStore.getEvents(sessionId, {
      afterSeq,
      limit,
    });

    return c.json({
      data: result.data,
      has_more: result.hasMore,
    });
  });

  return router;
}

/**
 * Decide whether a live SSE delta frame was already delivered by the Redis
 * backfill: true when the frame's turn was backfilled and its Redis entry id is
 * at or before the highest backfilled id for that turn. Non-delta frames (no
 * `turnId`) and deltas without an id always pass through.
 */
function isBackfilledDelta(
  frame: string,
  maxBackfilledIdForTurn: Map<string, string>,
): boolean {
  const meta = deltaMetaOfFrame(frame);
  if (!meta || meta.turnId === undefined || meta.deltaId === undefined) return false;
  const max = maxBackfilledIdForTurn.get(meta.turnId);
  if (max === undefined) return false;
  return compareStreamIds(meta.deltaId, max) <= 0;
}

function deltaMetaOfFrame(frame: string): { turnId?: string; deltaId?: string } | undefined {
  const match = /\ndata: (.*)\n\n$/.exec(frame);
  if (!match) return undefined;
  try {
    const parsed = JSON.parse(match[1]) as { turnId?: unknown; deltaId?: unknown };
    return {
      turnId: typeof parsed.turnId === "string" ? parsed.turnId : undefined,
      deltaId: typeof parsed.deltaId === "string" ? parsed.deltaId : undefined,
    };
  } catch {
    return undefined;
  }
}

/** Compare Redis stream ids of the shape "<ms>-<seq>". */
function compareStreamIds(a: string, b: string): number {
  const [aMs, aSeq] = a.split("-").map(Number);
  const [bMs, bSeq] = b.split("-").map(Number);
  if (aMs !== bMs) return aMs - bMs;
  return (aSeq || 0) - (bSeq || 0);
}
