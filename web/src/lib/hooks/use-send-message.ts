import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";

export function useSendMessage(sessionId: string) {
  const queryClient = useQueryClient();
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
      // Acceptance changes the Host's queue even if the current Turn keeps
      // running. Discard reads started before acceptance, then read it again.
      const queryKey = ["sessions", sessionId, "pending"];
      await queryClient.cancelQueries({ queryKey });
      void queryClient.invalidateQueries({ queryKey });
    } finally {
      setIsPending(false);
    }
  }

  return { send, isPending };
}
