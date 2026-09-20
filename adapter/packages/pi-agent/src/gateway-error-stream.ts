import {
  EventStream,
  type AssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
} from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

/** Translate gateway-specific codes into Pi's existing error vocabulary. */
function normalizeGatewayError(message: AssistantMessage): AssistantMessage {
  if (message.stopReason !== "error" || !message.errorMessage) return message;
  const error = message.errorMessage;
  // Account limits must win over HTTP 429 and any transient text in the body.
  const category = /\bAccountQuotaExceeded\b/i.test(error) ? "Quota exceeded"
    : /\bstream_read_error\b/i.test(error) ? "Network error"
    : /\bservice temporarily unavailable\b/i.test(error) ? "Service unavailable"
    : undefined;
  return category ? { ...message, errorMessage: `${category}: ${error}` } : message;
}

/** A pull-through view: no buffering, background pump or second retry loop. */
class GatewayErrorStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
  constructor(private readonly source: AssistantMessageEventStream) {
    super(
      event => event.type === "done" || event.type === "error",
      event => {
        if (event.type === "done") return event.message;
        if (event.type === "error") return event.error;
        throw new Error("Expected terminal assistant event");
      },
    );
  }

  override async *[Symbol.asyncIterator](): AsyncGenerator<AssistantMessageEvent> {
    for await (const event of this.source) {
      yield event.type === "error"
        ? { ...event, error: normalizeGatewayError(event.error) }
        : event;
    }
  }

  override async result(): Promise<AssistantMessage> {
    return normalizeGatewayError(await this.source.result());
  }
}

/**
 * Public per-Agent stream hook; pi-ai remains unmodified. AgentSession owns
 * bounded retry, backoff, abort, context overflow and completed tool history.
 * Keep the original gateway text verbatim after a human-readable category.
 */
export function withGatewayErrors(streamFn: AgentSession["agent"]["streamFunction"]): AgentSession["agent"]["streamFunction"] {
  return async (model, context, options) =>
    new GatewayErrorStream(await streamFn(model, context, options));
}
