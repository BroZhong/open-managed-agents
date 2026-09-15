import type { ContentBlock } from "@open-managed-agents/adapter-core";

/** Max length of a derived Session title before truncation (with an ellipsis). */
const MAX_TITLE_LEN = 60;

/**
 * Derive a Session title from a `user.message` event's `data`: the first
 * non-empty text block, whitespace-collapsed, trimmed, and truncated to
 * ~60 chars (with an … when cut). Returns null when no eligible text exists.
 *
 * Accepts both message shapes the system uses on the wire:
 *   - `{ content: ContentBlock[] }` — the canonical shape the frontend sends on
 *     `POST /v1/sessions/:id/events`.
 *   - `{ text: string }` — a legacy/flat shape some callers still send.
 */
export function deriveTitleFromEventData(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;

  let text: string | undefined;
  if (Array.isArray(record.content)) {
    const firstText = (record.content as ContentBlock[]).find(
      (b): b is Extract<ContentBlock, { type: "text" }> =>
        !!b && typeof b === "object" && (b as ContentBlock).type === "text",
    );
    text = firstText?.text;
  } else if (typeof record.text === "string") {
    text = record.text;
  }

  return normalizeTitle(text);
}

function normalizeTitle(text: string | undefined): string | null {
  if (typeof text !== "string") return null;
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized === "") return null;
  return normalized.length > MAX_TITLE_LEN
    ? normalized.slice(0, MAX_TITLE_LEN) + "…"
    : normalized;
}
