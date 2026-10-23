/**
 * What the Skill Bundle migration (#266) may print about an error. The report,
 * the summary and the logs carry a message only when the tool composed it
 * itself from ids, paths, sizes and statuses ({@link MigrationError}). Any
 * other error (ali-oss, urllib, pg, Node) can carry a request line with the
 * bucket host and object key (`PUT https://<bucket>…/__oma/skills/…`), a
 * `raw xml: …` response body or SQL, so it is reduced to its name, code and
 * HTTP status.
 */

/** An error whose message the tool composed: safe to print. */
export class MigrationError extends Error {}

const TOKEN = /^[A-Za-z0-9_.-]{1,64}$/;

export function safeErrorMessage(error: unknown): string {
  if (error instanceof MigrationError) return error.message;
  const { name, code, status } = (typeof error === "object" && error !== null ? error : {}) as Record<string, unknown>;
  const parts = [typeof name === "string" && TOKEN.test(name) ? name : "Error"];
  if ((typeof code === "string" || typeof code === "number") && TOKEN.test(String(code))) parts.push(`code ${code}`);
  if (typeof status === "number" && Number.isInteger(status)) parts.push(`HTTP ${status}`);
  return parts.join(" ");
}
