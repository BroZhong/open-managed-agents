import { EventStream, type AssistantMessage, type AssistantMessageEvent, type AssistantMessageEventStream } from "@earendil-works/pi-ai";

const thinkingRejection = "The provider rejected a thinking control parameter. Review this model’s advanced thinking settings before retrying. No thinking settings were changed.";
function isThinkingRejection(bodyText: string): boolean {
  const authOrLimit = /(?:authentication|permission|rate_limit|overloaded)_error|invalid[_ ](?:api[_ ])?key|unauthori[sz]ed|forbidden|rate[-_ ]limit|quota|insufficient[_ ](?:credit|balance)|\b(?:401|403|429)\b/i.test(bodyText);
  return !authOrLimit && /reasoning(?:_effort)?|thinking|budget_tokens|effort/i.test(bodyText)
    && /unsupported|not supported|not allowed|not permitted|unrecognized|unknown|invalid|unexpected|rejected a thinking control parameter/i.test(bodyText);
}

/** Fixed diagnostics only: upstream bodies can contain credentials or prompts. */
export function customProviderFailureMessage(status?: number, bodyText = ""): string {
  if ((status === 400 || status === 422) && isThinkingRejection(bodyText)) {
    return thinkingRejection;
  }
  if (status === 401 || status === 403) return `The provider rejected this request (HTTP ${status}). Check the API key and model access.`;
  if (status === 429) return "The provider rate-limited this request (HTTP 429). Check quota or retry later.";
  if (status) return `The provider rejected this request (HTTP ${status}). Check the protocol, URL and model configuration.`;
  return "The provider did not complete this request. Check the connection, protocol and model configuration.";
}

/** Pi already parsed the SSE failure. Classify its bounded text, never expose it
 * or read/parse the successful response stream a second time. */
function streamFailure(message: string | undefined): string {
  const text = (message ?? "").slice(0, 16_384);
  return isThinkingRejection(text) ? thinkingRejection : customProviderFailureMessage();
}

/** Read only bounded error text; never parse or rewrite successful payloads. */
async function responseFailure(response: Response): Promise<string> {
  const reader = response.clone().body?.getReader();
  if (!reader) return customProviderFailureMessage(response.status);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < 16_384) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value.subarray(0, 16_384 - size);
      chunks.push(chunk);
      size += chunk.length;
    }
  } catch {
    return customProviderFailureMessage(response.status);
  } finally {
    void reader.cancel().catch(() => {});
  }
  return customProviderFailureMessage(response.status, Buffer.concat(chunks).toString("utf8"));
}

class CustomProviderErrorStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
  constructor(private readonly source: AssistantMessageEventStream, private readonly diagnostic: (message: AssistantMessage) => string) {
    super(event => event.type === "done" || event.type === "error", event => {
      if (event.type === "done") return event.message;
      if (event.type === "error") return event.error;
      throw new Error("Expected a terminal event");
    });
  }
  private sanitize(message: AssistantMessage): AssistantMessage {
    return message.stopReason === "error" || message.stopReason === "aborted"
      ? { ...message, errorMessage: message.stopReason === "aborted" ? "Request aborted." : this.diagnostic(message) }
      : { ...message };
  }
  override async *[Symbol.asyncIterator](): AsyncGenerator<AssistantMessageEvent> {
    for await (const event of this.source) {
      // Pi mutates its shared partial message on later failures. Snapshot its
      // top-level fields so a previously emitted event cannot gain raw errors.
      yield event.type === "error" ? { ...event, error: this.sanitize(event.error) }
        : event.type === "done" ? { ...event, message: this.sanitize(event.message) }
        : { ...event, partial: this.sanitize(event.partial) };
    }
  }
  override async result(): Promise<AssistantMessage> { return this.sanitize(await this.source.result()); }
}

/** Per-request state prevents concurrent Tenant requests sharing diagnostics. */
export function safeCustomProviderStream(
  requestFetch: typeof fetch,
  start: (fetch: typeof globalThis.fetch) => AssistantMessageEventStream,
): AssistantMessageEventStream {
  let diagnostic = customProviderFailureMessage();
  let successfulResponse = false;
  const guardedFetch: typeof fetch = async (input, init) => {
    const response = await requestFetch(input, init);
    successfulResponse = response.ok;
    diagnostic = response.ok ? customProviderFailureMessage() : await responseFailure(response);
    return response;
  };
  return new CustomProviderErrorStream(start(guardedFetch), message => successfulResponse ? streamFailure(message.errorMessage) : diagnostic);
}
