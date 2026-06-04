import { useState, useEffect, useRef } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SessionEvent } from "@/lib/types";

interface TimelineViewProps {
  events: SessionEvent[];
}

function formatTimestamp(ts: string): string {
  const date = new Date(ts);
  return date.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
  });
}

function getEventTypeColor(type: string): string {
  if (type.startsWith("user.")) return "bg-blue-100 text-blue-700";
  if (type.startsWith("session.error")) return "bg-red-100 text-red-700";
  if (type.startsWith("session.")) return "bg-amber-100 text-amber-700";
  if (type.startsWith("span.")) return "bg-purple-100 text-purple-700";
  return "bg-neutral-100 text-neutral-600";
}

function TimelineRow({ event }: { event: SessionEvent }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className={cn(
        "border-b border-neutral-100",
        event.seq % 2 === 0 ? "bg-neutral-50" : "bg-white",
      )}
    >
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-3 px-4 py-2 text-left text-sm hover:bg-neutral-100"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 text-neutral-400" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-neutral-400" />
        )}
        <span className="w-28 flex-shrink-0 font-mono text-xs text-neutral-500">
          {formatTimestamp(event.ts)}
        </span>
        <span
          className={cn(
            "inline-flex rounded px-2 py-0.5 text-xs font-medium",
            getEventTypeColor(event.type),
          )}
        >
          {event.type}
        </span>
      </button>
      {expanded && (
        <pre className="mx-4 mb-3 mt-1 overflow-x-auto rounded bg-neutral-50 p-3 text-xs font-mono">
          {JSON.stringify(event.data, null, 2)}
        </pre>
      )}
    </div>
  );
}

export function TimelineView({ events }: TimelineViewProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [hasNewEvents, setHasNewEvents] = useState(false);
  const prevEventsLenRef = useRef(0);

  // Track scroll position
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    function handleScroll() {
      if (!container) return;
      const { scrollTop, scrollHeight, clientHeight } = container;
      const atBottom = scrollHeight - scrollTop - clientHeight < 100;
      setIsAtBottom(atBottom);
      if (atBottom) setHasNewEvents(false);
    }

    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, []);

  // Auto-scroll on new events
  useEffect(() => {
    if (events.length > prevEventsLenRef.current) {
      if (isAtBottom) {
        bottomRef.current?.scrollIntoView({ behavior: "smooth" });
      } else {
        setHasNewEvents(true);
      }
    }
    prevEventsLenRef.current = events.length;
  }, [events.length, isAtBottom]);

  function scrollToBottom() {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    setHasNewEvents(false);
  }

  return (
    <div className="relative flex h-full flex-col">
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto">
        {events.length === 0 && (
          <div className="flex items-center justify-center py-24 text-neutral-400">
            No events yet.
          </div>
        )}
        {events.map((event) => (
          <TimelineRow key={event.seq} event={event} />
        ))}
        <div ref={bottomRef} />
      </div>

      {hasNewEvents && (
        <button
          onClick={scrollToBottom}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-neutral-800 px-4 py-1.5 text-xs text-white shadow-lg transition-opacity hover:bg-neutral-700"
        >
          ↓ New events
        </button>
      )}
    </div>
  );
}
