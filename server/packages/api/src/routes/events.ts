import { Hono } from "hono";
import type { EventLogStore, PendingEventStore, SessionStore } from "@oma-server/store";
import type { EventStreamHub } from "@oma-server/event-log";
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
      const includeChunks = c.req.query("include") === "chunks";

      const shouldReplay = replayParam === "1" || lastEventId !== undefined;

      const { stream: liveStream, unsubscribe } = deps.eventStreamHub.subscribe(
        sessionId,
        { includeChunks },
      );

      const responseStream = new ReadableStream<string>({
        start: async (controller) => {
          // Send retry directive as first frame
          controller.enqueue("retry: 1000\n\n");

          // Replay historical events if requested
          if (shouldReplay) {
            let afterSeq: number | undefined;
            if (lastEventId) {
              const parsed = parseInt(lastEventId, 10);
              if (!isNaN(parsed)) {
                afterSeq = parsed;
              }
            }

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
          }

          // Pipe live events from hub subscription
          const reader = liveStream.getReader();
          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
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
