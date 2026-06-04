import { useState } from "react";
import { apiFetch } from "@/lib/api";

export function useSendMessage(sessionId: string) {
  const [isPending, setIsPending] = useState(false);

  async function send(text: string) {
    setIsPending(true);
    try {
      await apiFetch(`/v1/sessions/${sessionId}/events`, {
        method: "POST",
        body: JSON.stringify({
          events: [
            {
              type: "user.message",
              data: { content: [{ type: "text", text }] },
            },
          ],
        }),
      });
    } finally {
      setIsPending(false);
    }
  }

  return { send, isPending };
}
