import { useCallback, useState } from "react";
import { apiFetch } from "@/lib/api";

/**
 * Ask the Host to stop this Session's running Turn.
 *
 * The Host answers whether it actually stopped one: `false` means there was no
 * running Turn it could reach, which the caller may surface instead of pretending
 * the Stop worked (issue #113). An Interrupt only ends the current Turn — input
 * the user already queued still runs afterwards.
 */
export function useInterrupt(sessionId: string) {
  const [isPending, setIsPending] = useState(false);

  const interrupt = useCallback(async (): Promise<boolean> => {
    setIsPending(true);
    try {
      const body = await apiFetch<{ accepted?: boolean; interrupted?: boolean }>(
        `/v1/sessions/${sessionId}/events`,
        {
          method: "POST",
          // An interrupt must be alone in its batch — the Host rejects a mixed one.
          body: JSON.stringify({ events: [{ type: "user.interrupt", data: {} }] }),
        },
      );
      return body?.interrupted === true;
    } finally {
      setIsPending(false);
    }
  }, [sessionId]);

  return { interrupt, isPending };
}
