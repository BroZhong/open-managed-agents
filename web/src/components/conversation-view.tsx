import { useEffect, useRef, useState, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AlertCircle, ChevronDown } from "lucide-react";
import type { SessionDelta, SessionEvent } from "@/lib/types";
import {
  processEventsToMessages,
  shouldShowTypingIndicator,
  type DisplayMessage,
} from "@/lib/conversation-projection";
import { ThinkingBlock } from "@/components/thinking-block";
import { ToolCard } from "@/components/tool-card";

interface Turn {
  id: string;
  userMessage: DisplayMessage | null;
  responses: DisplayMessage[];
  isComplete: boolean;
}

function groupMessagesIntoTurns(messages: DisplayMessage[], isStreaming: boolean): Turn[] {
  const turns: Turn[] = [];
  let currentTurn: Turn | null = null;

  for (const msg of messages) {
    if (msg.role === "user") {
      if (currentTurn) {
        turns.push(currentTurn);
      }
      currentTurn = {
        id: msg.id,
        userMessage: msg,
        responses: [],
        isComplete: false,
      };
    } else {
      if (!currentTurn) {
        currentTurn = {
          id: `turn-orphan-${msg.id}`,
          userMessage: null,
          responses: [],
          isComplete: false,
        };
      }
      currentTurn.responses.push(msg);
    }
  }

  if (currentTurn) {
    turns.push(currentTurn);
  }

  // A turn is complete if it has responses, is not the last turn, OR is the last turn but not streaming
  for (let i = 0; i < turns.length; i++) {
    const isLast = i === turns.length - 1;
    if (isLast) {
      turns[i].isComplete = !isStreaming && turns[i].responses.length > 0;
    } else {
      turns[i].isComplete = true;
    }
  }

  return turns;
}

interface ConversationViewProps {
  events: SessionEvent[];
  activeDeltas?: SessionDelta[];
  sessionStatus: "idle" | "running";
}

export function ConversationView({
  events,
  activeDeltas = [],
  sessionStatus,
}: ConversationViewProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [hasNewMessages, setHasNewMessages] = useState(false);
  const prevProjectionSizeRef = useRef(0);

  const { messages, isStreaming } = useMemo(
    () => processEventsToMessages(events, activeDeltas),
    [events, activeDeltas],
  );

  const turns = useMemo(
    () => groupMessagesIntoTurns(messages, isStreaming),
    [messages, isStreaming],
  );
  const projectionSize = events.length + activeDeltas.length;

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    function handleScroll() {
      if (!container) return;
      const { scrollTop, scrollHeight, clientHeight } = container;
      const atBottom = scrollHeight - scrollTop - clientHeight < 100;
      setIsAtBottom(atBottom);
      if (atBottom) setHasNewMessages(false);
    }

    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, []);

  useEffect(() => {
    if (projectionSize > prevProjectionSizeRef.current) {
      if (isAtBottom) {
        bottomRef.current?.scrollIntoView({ behavior: "smooth" });
      } else {
        setHasNewMessages(true);
      }
    }
    prevProjectionSizeRef.current = projectionSize;
  }, [projectionSize, isAtBottom]);

  function scrollToBottom() {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    setHasNewMessages(false);
  }

  const showTypingIndicator = shouldShowTypingIndicator(messages, sessionStatus);

  return (
    <div className="relative flex h-full flex-col">
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto max-w-3xl space-y-6">
          {messages.length === 0 && (
            <div className="flex items-center justify-center py-24 text-[var(--color-fg-subtle)]">
              Send a message to start the conversation.
            </div>
          )}
          {turns.map((turn, idx) => (
            <TurnBlock
              key={turn.id}
              turn={turn}
              isLast={idx === turns.length - 1}
            />
          ))}
          {showTypingIndicator && <TypingIndicator />}
          <div ref={bottomRef} />
        </div>
      </div>

      {hasNewMessages && (
        <button
          onClick={scrollToBottom}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-[var(--color-fg)] px-4 py-1.5 text-xs text-white shadow-lg transition-opacity hover:opacity-80"
        >
          <ChevronDown className="mr-1 inline h-3 w-3" />
          New messages
        </button>
      )}
    </div>
  );
}

function TurnBlock({ turn, isLast }: { turn: Turn; isLast: boolean }) {
  const [expanded, setExpanded] = useState(false);

  // Find the last assistant/streaming message in the responses
  const lastAssistantMsg = [...turn.responses]
    .reverse()
    .find((m) => m.role === "assistant" || m.role === "assistant_streaming");

  // Should this turn be collapsible?
  const shouldCollapse = turn.isComplete && !isLast && turn.responses.length > 1;
  const showCollapsed = shouldCollapse && !expanded;

  // Count how many items are hidden
  const hiddenCount = showCollapsed
    ? turn.responses.length - (lastAssistantMsg ? 1 : 0)
    : 0;

  return (
    <div className="space-y-3">
      {/* User message */}
      {turn.userMessage && <UserBubble text={turn.userMessage.text} />}

      {/* Collapsed state: show expand button + last assistant message */}
      {showCollapsed ? (
        <div className="space-y-2">
          <button
            onClick={() => setExpanded(true)}
            className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs text-[var(--color-fg-subtle)] transition-colors hover:bg-[var(--color-bg-muted)] hover:text-[var(--color-fg-muted)]"
          >
            <ChevronDown className="h-3 w-3" />
            <span>{hiddenCount} steps hidden</span>
          </button>
          {lastAssistantMsg && (
            <MessageBubble message={lastAssistantMsg} />
          )}
        </div>
      ) : (
        /* Expanded state: show all responses */
        <div className="space-y-3">
          {shouldCollapse && expanded && (
            <button
              onClick={() => setExpanded(false)}
              className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs text-[var(--color-fg-subtle)] transition-colors hover:bg-[var(--color-bg-muted)] hover:text-[var(--color-fg-muted)]"
            >
              <ChevronDown className="h-3 w-3 rotate-180" />
              <span>Collapse</span>
            </button>
          )}
          {turn.responses.map((msg) => (
            <MessageBubble key={msg.id} message={msg} />
          ))}
        </div>
      )}
    </div>
  );
}

function MessageBubble({ message }: { message: DisplayMessage }) {
  switch (message.role) {
    case "user":
      return <UserBubble text={message.text} />;
    case "assistant":
      return <AssistantBubble text={message.text} aborted={message.aborted} />;
    case "assistant_streaming":
      return <AssistantBubble text={message.text} isStreaming />;
    case "thinking":
      return (
        <ThinkingBlock
          text={message.text}
          streaming={message.streaming}
        />
      );
    case "tool_use":
      return (
        <ToolCard
          name={message.name || "unknown"}
          toolUseId={message.toolUseId || ""}
          input={message.input}
          serverName={message.serverName}
          result={message.result}
          streaming={message.streaming}
        />
      );
    case "error":
      return <ErrorBlock text={message.text} />;
    default:
      return null;
  }
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-[var(--color-fg)] px-4 py-2.5 text-sm text-white shadow-sm">
        <p className="whitespace-pre-wrap">{text}</p>
      </div>
    </div>
  );
}

function AssistantBubble({
  text,
  isStreaming = false,
  aborted = false,
}: {
  text: string;
  isStreaming?: boolean;
  aborted?: boolean;
}) {
  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] rounded-2xl rounded-bl-sm bg-[var(--color-bg-surface)] px-4 py-3 text-sm text-[var(--color-fg)] shadow-sm ring-1 ring-[var(--color-border-subtle)]">
        {/* `prose*` comes from @tailwindcss/typography, loaded by
            `@plugin "@tailwindcss/typography"` in index.css. Without that
            @plugin line these are dead class names and every markdown element
            falls back to unstyled browser defaults (issue #117), so the guard
            test in index-css.test.ts pins the plugin in place.

            Why the `[&_x]:` overrides below beat the plugin: its rules are
            `.prose :where(x):not(:where(...))`, and `:where()` contributes
            zero specificity, so they score one class (0,1,0). `[&_x]:…`
            compiles to `.escaped-class x` — one class plus one element,
            (0,1,1). Cascade order therefore never enters into it. The one
            genuine tie is the root `color`: `.prose{color:var(--tw-prose-body)}`
            is also (0,1,0), so text colour needs `!` to be order-independent.

            Tables get GitHub's markdown treatment — `display:block` plus
            `width:max-content` and `overflow-x-auto` — so a wide table scrolls
            inside itself instead of bursting the max-w-[85%] bubble and
            overlapping neighbouring messages. No wrapper component needed.
            Under border-collapse the cells' own borders also win the CSS table
            border-conflict resolution against the plugin's thead/tr borders,
            which is why those need no separate override. */}
        <div className="prose prose-sm prose-neutral max-w-none text-[var(--color-fg)]! [&_p]:my-1.5 [&_pre]:rounded-lg [&_pre]:bg-[var(--color-bg-muted)] [&_pre]:text-[var(--color-fg)] [&_code]:text-[13px] [&_code]:font-normal [&_code]:before:content-none [&_code]:after:content-none [&_table]:my-2 [&_table]:block [&_table]:w-max [&_table]:max-w-full [&_table]:table-auto [&_table]:overflow-x-auto [&_table]:border-collapse [&_th]:border [&_th]:border-[var(--color-border)] [&_th]:px-2 [&_th]:py-1 [&_th]:font-semibold [&_td]:border [&_td]:border-[var(--color-border)] [&_td]:px-2 [&_td]:py-1">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
        </div>
        {isStreaming && (
          <span className="inline-block h-4 w-0.5 animate-pulse bg-[var(--color-fg-subtle)]" />
        )}
        {/* An Interrupt is the user's intent, not a fault, so this reads as a
            note rather than borrowing the error bubble's red. */}
        {aborted && (
          <p className="mt-1.5 text-xs text-[var(--color-fg-subtle)]">
            Stopped by you
          </p>
        )}
      </div>
    </div>
  );
}

function ErrorBlock({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
      <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
      <p>{text}</p>
    </div>
  );
}

function TypingIndicator() {
  return (
    <div className="flex justify-start">
      <div className="rounded-2xl rounded-bl-sm bg-[var(--color-bg-surface)] px-4 py-3 shadow-sm ring-1 ring-[var(--color-border-subtle)]">
        <div className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[var(--color-fg-subtle)] [animation-delay:0ms]" />
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[var(--color-fg-subtle)] [animation-delay:150ms]" />
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[var(--color-fg-subtle)] [animation-delay:300ms]" />
        </div>
      </div>
    </div>
  );
}
