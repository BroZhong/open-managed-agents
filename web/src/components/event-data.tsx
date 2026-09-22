import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";

export type EventDataLoader = (seq: number, signal: AbortSignal) => Promise<unknown>;

/** Mount only after the user opens a result. Closing cancels the request. */
export function EventData({ sessionId, seq, load, children }: {
  sessionId: string; seq: number; load?: EventDataLoader;
  children: (data: unknown) => React.ReactNode;
}) {
  const [state, setState] = useState<{ data?: unknown; error?: string; loaded?: boolean }>({});
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const request = load ? load(seq, controller.signal)
      : apiFetch<{ data: unknown }>(`/v1/sessions/${encodeURIComponent(sessionId)}/events/${seq}/data`, { signal: controller.signal }).then(r => r.data);
    request.then(data => {
      if (!controller.signal.aborted) setState({ data, loaded: true });
    }, () => {
      if (!controller.signal.aborted) setState({ error: "Could not load result." });
    });
    return () => controller.abort();
  }, [sessionId, seq, load, attempt]);
  if (state.error) return <div role="alert">{state.error} <button type="button" onClick={() => { setState({}); setAttempt(n => n + 1); }}>Retry</button></div>;
  if (!state.loaded) return <p role="status">Loading result…</p>;
  return <>{children(state.data)}</>;
}

/** Full images only, after expansion. Never stringify base64 into the DOM. */
export function ResultContent({ content }: { content: unknown }) {
  if (!Array.isArray(content)) return <pre>{typeof content === "string" ? content : JSON.stringify(content, null, 2)}</pre>;
  return <>{content.map((block, index) => {
    if (block?.type === "text") return <pre key={index}>{String(block.text ?? "")}</pre>;
    if (block?.type === "image") {
      const mime = block.mimeType ?? block.source?.mediaType;
      const data = block.data ?? block.source?.data;
      if (typeof data === "string" && /^image\/(png|jpeg|gif|webp|avif)$/i.test(mime ?? "")) {
        return <img key={index} src={`data:${mime};base64,${data}`} alt="Tool result" className="max-w-full" />;
      }
      return <p key={index}>Image format is not supported for display.</p>;
    }
    return <pre key={index}>{JSON.stringify(block, null, 2)}</pre>;
  })}</>;
}
