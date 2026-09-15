import { useEffect, useRef, useState, useMemo, createContext, useContext } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AlertCircle, ChevronDown, Circle, Check, Layers } from "lucide-react";
import type { SessionDelta, SessionEvent } from "@/lib/types";
import {
  processEventsToMessages,
  shouldShowTypingIndicator,
  type DisplayMessage,
} from "@/lib/conversation-projection";
import { ThinkingBlock } from "@/components/thinking-block";
import { SessionDisclosure } from "@/components/session-disclosure";
import { ToolCard } from "@/components/tool-card";

import { DelegationCard } from "@/components/delegation-card";
const SessionContext = createContext("");

interface Turn {
  id: string;
  userMessage: DisplayMessage | null;
  responses: DisplayMessage[];
}

function groupMessagesIntoTurns(messages: DisplayMessage[]): Turn[] {
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
      };
    } else {
      if (!currentTurn) {
        currentTurn = {
          id: `turn-orphan-${msg.id}`,
          userMessage: null,
          responses: [],
          };
      }
      currentTurn.responses.push(msg);
    }
  }

  if (currentTurn) {
    turns.push(currentTurn);
  }

  return turns;
}

interface ConversationViewProps {
  sessionId?: string;
  focusToolUseId?: string;
  events: SessionEvent[];
  activeDeltas?: SessionDelta[];
  sessionStatus: "idle" | "running" | "waiting";
}

export function ConversationView({
  events,
  sessionId = "",
  focusToolUseId,
  activeDeltas = [],
  sessionStatus,
}: ConversationViewProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const followBottomRef = useRef(true);
  const contentRef = useRef<HTMLDivElement>(null);

  const { messages } = useMemo(
    () => processEventsToMessages(events, activeDeltas),
    [events, activeDeltas],
  );

  const turns = useMemo(
    () => groupMessagesIntoTurns(messages),
    [messages],
  );

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    function handleScroll() {
      if (!container) return;
      const { scrollTop, scrollHeight, clientHeight } = container;
      const atBottom = scrollHeight - scrollTop - clientHeight < 100;
      setIsAtBottom(atBottom);
      followBottomRef.current = atBottom;
    }

    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, []);

  useEffect(() => {
    if (followBottomRef.current) bottomRef.current?.scrollIntoView({ behavior: "instant" });
  }, [messages]);

  // Images, tables and streaming text can grow without adding a message.
  useEffect(() => {
    if (!contentRef.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (followBottomRef.current) bottomRef.current?.scrollIntoView({ behavior: "instant" });
    });
    observer.observe(contentRef.current);
    return () => observer.disconnect();
  }, []);

  function scrollToBottom() {
    followBottomRef.current = true;
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    setIsAtBottom(true);
  }

  useEffect(() => {
    if (focusToolUseId) document.getElementById(`tool-${focusToolUseId}`)?.scrollIntoView({ block: "center" });
  }, [focusToolUseId, events.length]);

  const showTypingIndicator = shouldShowTypingIndicator(messages, sessionStatus);

  return (
    <SessionContext.Provider value={sessionId}><div className="relative flex h-full flex-col">
      <div ref={scrollContainerRef} className="conversation-scroll flex-1 overflow-y-auto px-6 py-6">
        <div ref={contentRef} className="session-thread">
          {messages.length === 0 && (
            <div className="session-welcome"><h2>What would you like to work on?</h2><p>Send a message to start the conversation.</p></div>
          )}
          {turns.map((turn, idx) => (
            <TurnBlock
              key={turn.id}
              turn={turn}
              running={idx === turns.length - 1 && (sessionStatus === "running" || sessionStatus === "waiting")}
              focusToolUseId={focusToolUseId}
            />
          ))}
          {showTypingIndicator && <TypingIndicator />}
          <div ref={bottomRef} />
        </div>
      </div>

      {!isAtBottom && (
        <button
          onClick={scrollToBottom}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-[var(--color-fg)] px-4 py-1.5 text-xs text-white shadow-lg transition-opacity hover:opacity-80"
        >
          <ChevronDown className="mr-1 inline h-3 w-3" />
          Jump to latest
        </button>
      )}
    </div></SessionContext.Provider>
  );
}

function TurnBlock({ turn, running, focusToolUseId }: { turn: Turn; running: boolean; focusToolUseId?: string }) {
  const activity = turn.responses.filter((message) => message.role === "thinking" || message.role === "tool_use");
  const answers = turn.responses.filter((message) => message.role !== "thinking" && message.role !== "tool_use");
  const focused = activity.some((message) => !!focusToolUseId && message.toolUseId === focusToolUseId);
  return (
    <div className="session-turn">
      {turn.userMessage && <UserBubble text={turn.userMessage.text} />}
      {activity.length > 0 && <ProcessGroup key={`process:${focused ? focusToolUseId : ""}`} messages={activity} running={running} focused={focused} />}
      {answers.map((message) => <MessageBubble key={message.id} message={message} />)}
    </div>
  );
}

function ProcessGroup({ messages, running, focused }: { messages: DisplayMessage[]; running: boolean; focused: boolean }) {
  const tools = messages.filter((message) => message.role === "tool_use");
  const thinking = messages.some((message) => message.role === "thinking");
  const failed = tools.filter((message) => message.result?.isError).length;
  const incomplete = tools.some((message) => !message.result);
  const active = running && (incomplete || messages.some((message) => message.streaming));
  const status = active ? "Working" : failed ? "Needs attention" : incomplete ? "Incomplete" : "Explored";
  const description = [thinking ? "reasoning" : "", tools.length ? `${tools.length} tool ${tools.length === 1 ? "call" : "calls"}` : ""].filter(Boolean).join(" · ");
  return (
    <SessionDisclosure className="session-process" active={active} defaultOpen={failed > 0 || focused} summary={<>
      {active ? <Circle size={12} className="animate-pulse" /> : failed || incomplete ? <Layers size={14} /> : <Check size={14} />}
      <span>{status} · {description}{failed ? ` · ${failed} failed` : ""}</span>
    </>}>
      {messages.map((message) => <MessageBubble key={message.id} message={message} running={running} />)}
    </SessionDisclosure>
  );
}

function MessageBubble({ message, running = false }: { message: DisplayMessage; running?: boolean }) {
  const sessionId = useContext(SessionContext);
  switch (message.role) {
    case "user":
      return <UserBubble text={message.text} />;
    case "assistant":
      return <AssistantBubble text={message.text} aborted={message.aborted} />;
    case "assistant_streaming":
      return <AssistantBubble text={message.text} isStreaming />;
    case "instruction":
      return <div className="rounded-xl border border-blue-200 p-3 text-sm"><strong>Delegated instruction</strong><p className="whitespace-pre-wrap">{message.text}</p></div>;
    case "notification":
      return <div className="rounded-xl border border-blue-200 p-3 text-sm"><strong>Subagent result</strong><p className="whitespace-pre-wrap">{message.text}</p></div>;
    case "thinking":
      return (
        <ThinkingBlock
          text={message.text}
          streaming={running && message.streaming}
        />
      );
    case "tool_use":
      if (sessionId && message.name === "Agent") return <DelegationCard sessionId={sessionId} message={message} />;
      return (
        <ToolCard
          name={message.name || "unknown"}
          toolUseId={message.toolUseId || ""}
          input={message.input}
          serverName={message.serverName}
          result={message.result}
          streaming={running && message.streaming}
          running={running}
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
      <div className="session-user-bubble">
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
      <div className="session-answer min-w-0 w-full max-w-full py-3 text-sm text-[var(--color-fg)] break-words">
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
            inside itself instead of bursting the message column and
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
  return <div className="session-working" role="status"><Circle size={12} className="animate-pulse" /><span>Working…</span></div>;
}
