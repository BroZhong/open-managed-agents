import { createHash } from "node:crypto";

/** One policy for storage, historical HTTP responses and live SSE. */
export const BIG_RESULT_BYTES = 64 * 1024;
export interface EventPayloadRef { version: 1; sha256: string; bytes: number }
export interface EventPayloadStore {
  put(sessionId: string, sha256: string, body: Buffer): Promise<void>;
  get(sessionId: string, sha256: string): Promise<Buffer>;
}

function record(value: unknown): Record<string, any> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

export function eventPayloadRef(data: unknown, type?: string): EventPayloadRef | undefined {
  if (type !== undefined && !isResult(type, record(data) ?? {})) return undefined;
  const ref = record(data)?.payloadRef;
  return ref?.version === 1 && typeof ref.sha256 === "string" && /^[a-f0-9]{64}$/.test(ref.sha256)
    && Number.isSafeInteger(ref.bytes) && ref.bytes > 0 ? ref : undefined;
}

function isResult(type: string, data: Record<string, any>): boolean {
  return type === "agent.tool_result" || type === "agent.mcp_tool_result"
    || type === "agent.context_entry" && data.entry?.type === "message" && data.entry.message?.role === "toolResult";
}

/** JSON permits NUL and unpaired UTF-16 surrogates; PostgreSQL jsonb does not. */
function hasUnsupportedJsonbText(value: unknown): boolean {
  // Unicode mode matches lone surrogate code points, but leaves paired emoji intact.
  if (typeof value === "string") return /[\u0000\ud800-\udfff]/u.test(value);
  if (Array.isArray(value)) return value.some(hasUnsupportedJsonbText);
  if (value !== null && typeof value === "object") {
    return Object.entries(value).some(([key, item]) =>
      hasUnsupportedJsonbText(key) || hasUnsupportedJsonbText(item));
  }
  return false;
}

/** No preview and no result bytes. Keep only identity/status for pairing and replay. */
export function lazyEventData(type: string, value: unknown): unknown {
  const data = record(value);
  if (!data || eventPayloadRef(data) || !isResult(type, data)) return value;
  const body = Buffer.from(JSON.stringify(data));
  // Preserve exact result bytes in OSS even when a binary/text result is small.
  // Inspect decoded strings, not JSON escape spellings: literal "\\u0000" is safe.
  if (body.length < BIG_RESULT_BYTES && !hasUnsupportedJsonbText(data)) return value;
  const out: Record<string, unknown> = {};
  for (const key of ["id", "type", "timestamp", "turnId", "blockIndex", "toolUseId", "isError", "serverName", "sdk", "inputEventId", "executionId", "callerSessionId", "callerTurnId", "callerToolUseId", "presentation"]) {
    if (data[key] !== undefined) out[key] = data[key];
  }
  if (type === "agent.context_entry") {
    const { id, parentId, timestamp, type: entryType, message } = data.entry;
    out.entry = { id, parentId, timestamp, type: entryType,
      message: { role: message.role, toolCallId: message.toolCallId, toolName: message.toolName, isError: message.isError, timestamp: message.timestamp } };
  }
  out.payloadRef = { version: 1, sha256: createHash("sha256").update(body).digest("hex"), bytes: body.length } satisfies EventPayloadRef;
  return out;
}

/** The SDK only sees decoded data. The durable representation is private to Host. */
export class EventPayloadCodec {
  constructor(private readonly objects: EventPayloadStore) {}

  async encode(sessionId: string, type: string, data: unknown): Promise<unknown> {
    if (eventPayloadRef(data, type)) return data; // Already externalized checkpoint.
    const projection = lazyEventData(type, data);
    const ref = eventPayloadRef(projection, type);
    if (ref) await this.objects.put(sessionId, ref.sha256, Buffer.from(JSON.stringify(data)));
    return projection;
  }

  async decode(sessionId: string, data: unknown, type?: string): Promise<unknown> {
    const ref = eventPayloadRef(data, type);
    if (!ref) return data;
    const body = await this.objects.get(sessionId, ref.sha256);
    if (body.length !== ref.bytes || createHash("sha256").update(body).digest("hex") !== ref.sha256) {
      throw new Error("Session result integrity check failed");
    }
    return JSON.parse(body.toString("utf8"));
  }

  async checkpoint(sessionId: string, checkpoint: Record<string, unknown>, decode = false): Promise<Record<string, unknown>> {
    if (!Array.isArray(checkpoint.events)) return checkpoint;
    const events = [];
    for (const event of checkpoint.events) {
      events.push(decode ? await this.decode(sessionId, event, event.type) : await this.encode(sessionId, event.type, event));
    }
    return { ...checkpoint, events };
  }
}
