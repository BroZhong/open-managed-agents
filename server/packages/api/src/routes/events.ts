import { Hono } from "hono";
import type { EventLogStore, PendingEventStore, SessionStore } from "@oma-server/store";
import type { EventStreamHub } from "@oma-server/event-log";
import { alignedChunkData } from "@oma-server/event-log";
import type { TurnStreamStore } from "@oma-server/redis";
import type { SessionRouter } from "@oma-server/session-router";
import type { TenantContext } from "../types.js";

type Env = {
  Variables: {
    tenant: TenantContext;
  };
};

export interface EventRouteDeps {
  eventLogStore: EventLogStore;
  pendingEventStore: PendingEventStore;
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
}

const ALLOWED_USER_TYPES = [
  "user.message",
  "user.interrupt",
  "user.tool_confirmation",
  "user.custom_tool_result",
  "user.define_outcome",
] as const;

type AllowedUserType = (typeof ALLOWED_USER_TYPES)[number];

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

    const body = await c.req.json().catch(() => null);
    if (!body || !Array.isArray(body.events)) {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    let hasPendingTrigger = false;

    for (const event of body.events) {
      const { type, data } = event;

      if (!ALLOWED_USER_TYPES.includes(type as AllowedUserType)) {
        return c.json({ error: `Unsupported event type: ${type}` }, 400);
      }

      if (type === "user.interrupt") {
        if (deps.sessionRouter) {
          deps.sessionRouter.interrupt(sessionId);
        }
        return c.json({ accepted: true, interrupted: true }, 202);
      }

      const isPending = type === "user.message" ||
        type === "user.tool_confirmation" ||
        type === "user.custom_tool_result";

      if (isPending) {
        // Write to pending queue (will be promoted to canonical log by session-router)
        await deps.pendingEventStore.enqueue(sessionId, {
          type,
          data,
          sessionThreadId: "sthr_primary",
        });
        hasPendingTrigger = true;
      } else {
        // Non-pending events (user.define_outcome) go directly to canonical log
        await deps.eventLogStore.append(sessionId, {
          type,
          data,
          sessionThreadId: "sthr_primary",
        });
      }
    }

    // Trigger session router if we enqueued pending events
    if (hasPendingTrigger && deps.sessionRouter) {
      deps.sessionRouter.handleNewEvent(sessionId, session.agent);
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

      const responseStream = new ReadableStream<string>({
        start: async (controller) => {
          // Send retry directive as first frame
          controller.enqueue("retry: 1000\n\n");

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

            // 1. Completed Events from PostgreSQL (authoritative log).
            const result = await deps.eventLogStore.getEvents(sessionId, {
              afterSeq,
              limit: 1000,
            });

            for (const event of result.data) {
              let frame = `event: ${event.type}\n`;
              frame += `id: ${event.seq}\n`;
              frame += `data: ${JSON.stringify(event.data)}\n\n`;
              controller.enqueue(frame);
            }

            // 2. Active turn's half-emitted deltas from Redis (if a turn is
            //    still running). Once a turn ends its stream is reclaimed and
            //    the full content already came from PostgreSQL above, so there
            //    is nothing (and nothing needed) to backfill.
            if (turnStreamStore) {
              const active = await turnStreamStore.getActiveTurn(sessionId);
              if (active && active.status === "running") {
                const deltas = await turnStreamStore.readDeltas(active.turnId);
                for (const delta of deltas) {
                  const data = alignedChunkData({
                    data: delta.data,
                    turnId: delta.turnId,
                    blockIndex: delta.blockIndex,
                    deltaId: delta.id,
                  });
                  controller.enqueue(
                    `event: ${delta.type}\ndata: ${JSON.stringify(data)}\n\n`,
                  );
                }
                if (deltas.length > 0) {
                  maxBackfilledIdForTurn.set(active.turnId, deltas[deltas.length - 1].id);
                }
              }
            }
          }

          // Pipe live events from hub subscription, dropping delta frames that
          // were already covered by the Redis backfill.
          const reader = liveStream.getReader();
          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              if (shouldReplay && maxBackfilledIdForTurn.size > 0) {
                if (isBackfilledDelta(value, maxBackfilledIdForTurn)) continue;
              }
              controller.enqueue(value);
            }
          } catch {
            // stream cancelled
          } finally {
            controller.close();
          }
        },
        cancel: () => {
          unsubscribe();
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
          "cache-control": "no-cache",
          "connection": "keep-alive",
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
