import type { OpenAPIHono } from "@hono/zod-openapi";
import type { EventLogIngressStore, PendingEventIngressStore, SessionStore } from "@oma-server/store";
import type { EventStreamHub } from "@oma-server/event-log";
import type { SessionRouter } from "@oma-server/session-router";
import type { ContentBlock } from "@open-managed-agents/adapter-core";
import type { TenantContext } from "../types.js";
import { deriveTitleFromContent } from "../lib/derive-title.js";
import { getOpenApiRoute } from "../openapi/routes.js";
import {
  createContractRouter,
  registerContractRoute,
} from "../openapi/router.js";

type Env = {
  Variables: {
    tenant: TenantContext;
  };
};

export interface MessageRouteDeps {
  eventLogStore: EventLogIngressStore;
  pendingEventStore: PendingEventIngressStore;
  sessionStore: SessionStore;
  eventStreamHub: EventStreamHub;
  sessionRouter: SessionRouter;
}

function completesPendingEvent(frame: string, pendingEventId: string): boolean {
  for (const block of frame.split("\n\n")) {
    const lines = block.split("\n");
    if (!lines.some((line) => line === "event: session.turn_completed")) continue;

    const dataLine = lines.find((line) => line.startsWith("data: "));
    if (!dataLine) continue;
    try {
      const data = JSON.parse(dataLine.slice("data: ".length)) as {
        pendingEventId?: unknown;
      };
      if (data.pendingEventId === pendingEventId) return true;
    } catch {
      // Ignore malformed/unrelated frames; only an exact durable completion
      // marker may terminate this request's stream.
    }
  }
  return false;
}

/**
 * NOTE (issue #70): `POST /v1/sessions/:id/messages` is a legacy "send message
 * and stream the response back on the same request" route that no current
 * client uses — the frontend sends via `POST /v1/sessions/:id/events`. Its
 * title-snapshot logic is kept here for parity but now shares the single
 * derivation helper (`deriveTitleFromContent`) with the `/events` path so the
 * two routes can never silently diverge.
 */
export function messageRoutes(deps: MessageRouteDeps): OpenAPIHono<Env> {
  const router = createContractRouter<Env>();

  // POST /v1/sessions/:id/messages — Send a message and stream response
  registerContractRoute(router, getOpenApiRoute("sendSessionMessage"), async (c) => {
    const sessionId = c.req.param("id")!;
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
    if (!body || !body.content) {
      return c.json({ error: "Missing required field: content" }, 400);
    }

    // Normalize content to ContentBlock[]
    let content: ContentBlock[];
    if (typeof body.content === "string") {
      if (body.content.trim() === "") {
        return c.json({ error: "Content must not be empty" }, 400);
      }
      content = [{ type: "text", text: body.content }];
    } else if (Array.isArray(body.content)) {
      if (body.content.length === 0) {
        return c.json({ error: "Content must not be empty" }, 400);
      }
      content = body.content as ContentBlock[];
    } else {
      return c.json({ error: "Content must not be empty" }, 400);
    }

    // Subscribe before enqueue. An already-running drainer may pick up this
    // queue tail without waiting for our explicit handleNewEvent trigger, so
    // subscribing later could miss an extremely fast completion marker.
    const { stream: liveStream, unsubscribe } = deps.eventStreamHub.subscribe(
      sessionId,
      { includeChunks: true },
    );

    // Atomically serialize acceptance with Session termination. A rejected or
    // failed enqueue tears down the speculative subscription immediately.
    let inserted;
    try {
      inserted = await deps.pendingEventStore.enqueueBatchIfSessionActive(sessionId, [{
        type: "user.message",
        data: { content },
        sessionThreadId: "sthr_primary",
        ...(tenant.apiKeyId ? { apiKeyId: tenant.apiKeyId } : {}),
      }]);
    } catch (error) {
      unsubscribe();
      throw error;
    }
    if (!inserted) {
      unsubscribe();
      return c.json({ error: "Session is terminated" }, 410);
    }
    const pendingEvent = inserted[0]!;

    // Snapshot a title from the FIRST accepted user message (only when unset,
    // so later messages never overwrite it). Best-effort: a title failure must
    // never invalidate already-durable input.
    if (!session.title) {
      const derived = deriveTitleFromContent(content);
      if (derived) {
        try {
          await deps.sessionStore.setTitle(sessionId, derived);
        } catch {
          // ignore — titling is non-essential
        }
      }
    }

    // Trigger session router (fire and forget — it publishes to the hub)
    void deps.sessionRouter.handleNewEvent(sessionId, session.agent).catch((error) => {
      // The accepted input remains pending and can be recovered/retried.
      console.error(`SessionRouter failed after accepting input for ${sessionId}:`, error);
    });

    // A Session can become idle between queued Turns. Close only when the
    // durable completion marker belongs to this request's pending input.
    const responseStream = new ReadableStream<string>({
      start: async (controller) => {
        controller.enqueue("retry: 1000\n\n");

        const reader = liveStream.getReader();
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            controller.enqueue(value);

            if (completesPendingEvent(value, pendingEvent.id)) {
              break;
            }
          }
        } catch {
          // stream cancelled
        } finally {
          unsubscribe();
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
  });

  return router;
}
