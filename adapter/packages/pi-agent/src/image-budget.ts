import type { ContextEvent, ExtensionFactory } from "@earendil-works/pi-coding-agent";

type Messages = ContextEvent["messages"];

export const DEFAULT_IMAGE_BUDGET_BYTES = 20 * 1024 * 1024;

/** Base64 image bytes allowed per request; `OMA_PI_IMAGE_BUDGET_BYTES` overrides. */
export function imageBudgetBytes(env: Record<string, string | undefined> = process.env): number {
  const value = Number(env.OMA_PI_IMAGE_BUDGET_BYTES);
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_IMAGE_BUDGET_BYTES;
}

/**
 * Pi resends every earlier image on each request, so a burst of image reads
 * exceeds provider request-body limits (DeepSeek ~50 MB, Anthropic 32 MB) long
 * before the token window, and overflow compaction keeps recent images
 * verbatim. Once images exceed `high`, the oldest become path placeholders
 * until at most `high / 2` remain.
 *
 * The decision replays the message list in order, so an appended history
 * repeats every earlier omission: the request prefix, and its provider cache,
 * changes only when another omission happens. Only Pi's per-request copy is
 * changed; Session entries and the journal keep the images.
 */
export function fitImageBudget(messages: Messages, high: number): Messages {
  const images: { message: number; block: number; bytes: number }[] = [];
  let kept = 0;
  let omitted = 0;
  messages.forEach((message, m) => {
    if ((message.role !== "user" && message.role !== "toolResult") || typeof message.content === "string") return;
    message.content.forEach((block, b) => {
      if (block.type !== "image") return;
      images.push({ message: m, block: b, bytes: block.data.length });
      kept += block.data.length;
      if (kept > high) while (kept > high / 2) kept -= images[omitted++].bytes;
    });
  });
  if (omitted === 0) return messages;

  const paths = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const block of message.content) {
      if (block.type === "toolCall" && typeof block.arguments.path === "string") paths.set(block.id, block.arguments.path);
    }
  }
  const blocks = new Map<number, Set<number>>();
  for (const { message, block } of images.slice(0, omitted)) blocks.set(message, (blocks.get(message) ?? new Set()).add(block));
  return messages.map((message, m) => {
    const omit = blocks.get(m);
    if (!omit || (message.role !== "user" && message.role !== "toolResult") || typeof message.content === "string") return message;
    const path = message.role === "toolResult" ? paths.get(message.toolCallId) : undefined;
    const text = path ? `[image omitted to fit request size: ${path}; read it again if needed]` : "[image omitted to fit request size]";
    return { ...message, content: message.content.map((block, b) => omit.has(b) ? { type: "text" as const, text } : block) };
  });
}

export const imageBudgetExtension = (high = imageBudgetBytes()): ExtensionFactory => pi => {
  pi.on("context", event => ({ messages: fitImageBudget(event.messages, high) }));
};
