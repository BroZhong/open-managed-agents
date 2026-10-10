const prefix = "updated_at:";

/** Keep the original timestamp string so PostgreSQL's sub-millisecond precision survives. */
export function encodeSessionUpdatedAtCursor(updatedAt: string, id: string): string {
  return prefix + Buffer.from(JSON.stringify([updatedAt, id])).toString("base64url");
}

export function decodeSessionUpdatedAtCursor(cursor: string): { updatedAt: string; id: string } | null {
  if (!cursor.startsWith(prefix)) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor.slice(prefix.length), "base64url").toString());
    if (!Array.isArray(value) || value.length !== 2) return null;
    const [updatedAt, id] = value;
    if (typeof updatedAt !== "string"
      || !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/.test(updatedAt)
      || !Number.isFinite(Date.parse(updatedAt)) || typeof id !== "string" || !id) return null;
    const date = updatedAt.slice(0, 10);
    // Date.parse normalizes dates such as February 30 that PostgreSQL rejects.
    if (date.startsWith("0000-") || new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) !== date) return null;
    return { updatedAt, id };
  } catch {
    return null;
  }
}
