import { Hono } from "hono";
import type { EventLogStore, PendingEventStore, SessionStore } from "@oma-server/store";
import type { EventStreamHub } from "@oma-server/event-log";
import type { SessionRouter } from "@oma-server/session-router";
import type { ContentBlock } from "@open-managed-agents/adapter-core";
import type { TenantContext } from "../types.js";

type Env = {
  Variables: {
    tenant: TenantContext;
  };
};

export interface MessageRouteDeps {
  eventLogStore: EventLogStore;
  pendingEventStore: PendingEventStore;
  sessionStore: SessionStore;
  eventStreamHub: EventStreamHub;
  sessionRouter: SessionRouter;
}

/**
 * Derive a Session title from the incoming message: the first text block,
 * trimmed, whitespace-collapsed, truncated to ~60 chars (with … if cut).
 * Returns null when there is no non-empty text block.
 */
function deriveTitle(content: ContentBlock[]): string | null {
  const firstText = content.find(
    (b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text",
  );
  if (!firstText) return null;
  const normalized = firstText.text.replace(/\s+/g, " ").trim();
  if (normalized === "") return null;
  const MAX = 60;
  return normalized.length > MAX ? normalized.slice(0, MAX) + "…" : normalized;
}

export function messageRoutes(deps: MessageRouteDeps) {
  const router = new Hono<Env>();

  // POST /v1/sessions/:id/messages — Send a message and stream response
  router.post("/v1/sessions/:id/messages", async (c) => {
    const sessionId = c.req.param("id");
    const tenant = c.get("tenant");

    // Validate session exists and belongs to tenant
    const session = await deps.sessionStore.getById(sessionId);
    if (!session || session.tenantId !== tenant.tenantId) {
      return c.json({ error: "Session not found" }, 404);
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

    // Snapshot a title from the FIRST user message (only when unset, so later
    // messages never overwrite it). Best-effort: a store failure must not break
    // message send.
    if (!session.title) {
      const derived = deriveTitle(content);
      if (derived) {
        try {
          await deps.sessionStore.setTitle(sessionId, derived);
        } catch {
          // ignore — titling is non-essential
        }
      }
    }

    // Subscribe to hub FIRST (before appending, to not miss events)
    const { stream: liveStream, unsubscribe } = deps.eventStreamHub.subscribe(
      sessionId,
      { includeChunks: true },
    );

    // Enqueue to pending store (session-router promotes it to canonical log)
    await deps.pendingEventStore.enqueue(sessionId, {
      type: "user.message",
      data: { content },
      sessionThreadId: "sthr_primary",
    });

    // Trigger session router (fire and forget — it publishes to the hub)
    deps.sessionRouter.handleNewEvent(sessionId, session.agent);

    // Stream until session.status_idle, then close
    const responseStream = new ReadableStream<string>({
      start: async (controller) => {
        controller.enqueue("retry: 1000\n\n");

        const reader = liveStream.getReader();
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            controller.enqueue(value);

            // Check if this is a session.status_idle event — end stream
            if (value.includes("event: session.status_idle")) {
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
