import { useCallback, useState } from "react";
import { apiFetch } from "@/lib/api";

/** Accept an Interrupt command; durable Turn events determine when it stops. */
export function useInterrupt(sessionId: string) {
  const [requestAccepted, setRequestAccepted] = useState(false);
  const [isPending, setIsPending] = useState(false);

  const interrupt = useCallback(async (): Promise<boolean> => {
    setIsPending(true);
    try {
      const body = await apiFetch<{ accepted?: boolean; interrupted?: boolean; requested?: boolean }>(
        `/v1/sessions/${sessionId}/events`,
        {
          method: "POST",
          // An interrupt must be alone in its batch — the Host rejects a mixed one.
          body: JSON.stringify({ events: [{ type: "user.interrupt", data: {} }] }),
        },
      );
      setRequestAccepted(body?.requested === true);
      return body?.interrupted === true;
    } finally {
      setIsPending(false);
    }
  }, [sessionId]);

  return { interrupt, isPending, requestAccepted };
}
