import type { Session } from "@/lib/hooks/use-sessions";

/** Keep active Turns first, preserving the list's existing order within each group. */
export function runningSessionsFirst(sessions: readonly Session[]): Session[] {
  const isActive = (session: Session) =>
    session.status === "running" || session.status === "waiting";
  return [...sessions].sort((a, b) => Number(isActive(b)) - Number(isActive(a)));
}
