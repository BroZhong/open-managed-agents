import { useEffect, useRef, useState, useMemo, createContext, useContext } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { AlertCircle, ChevronDown, Circle, Check, Layers } from "lucide-react";
import type { SessionDelta, SessionEvent } from "@/lib/types";
import {
  processEventsToMessages,
  shouldShowTypingIndicator,
  type DisplayMessage,
} from "@/lib/conversation-projection";
import { ConversationResourceLink } from "@/components/conversation-resource-link";
import { ConversationResourcesContext, CodeBlockContext, type ConversationResources } from "@/lib/conversation-resources";
import { ThinkingBlock } from "@/components/thinking-block";
import { SessionDisclosure } from "@/components/session-disclosure";
import { ToolCard } from "@/components/tool-card";

import { DelegationCard } from "@/components/delegation-card";
import type { DelegationExecution } from "@/lib/delegations";
import { resolveResourcePath } from "@/lib/resource-path";
import { processTimings, formatElapsedTime, type ProcessTiming } from "@/lib/process-timing";
const SessionContext = createContext("");
const OpenExecutionContext = createContext<((execution: DelegationExecution) => void) | undefined>(undefined);

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
  onOpenWorkspaceFile?: (path: string) => void;
  resources?: ConversationResources;
  onOpenExecution?: (execution: DelegationExecution) => void;
  sessionId?: string;
  focusToolUseId?: string;
  events: SessionEvent[];
  activeDeltas?: SessionDelta[];
  sessionStatus: "idle" | "running" | "waiting";
}

export function ConversationView({
  onOpenWorkspaceFile,
  resources,
  onOpenExecution,
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
  const timings = useMemo(() => processTimings(messages, events, activeDeltas), [messages, events, activeDeltas]);

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
    <ConversationResourcesContext.Provider value={resources ?? (onOpenWorkspaceFile ? { agentId: "", skills: [], onOpenWorkspacePath: onOpenWorkspaceFile } : undefined)}><SessionContext.Provider value={sessionId}><OpenExecutionContext.Provider value={onOpenExecution}><div className="relative flex h-full flex-col">
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
              timings={timings}
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
    </div></OpenExecutionContext.Provider></SessionContext.Provider></ConversationResourcesContext.Provider>
  );
}

function TurnBlock({ turn, running, focusToolUseId, timings }: { turn: Turn; running: boolean; focusToolUseId?: string; timings: Map<string, ProcessTiming> }) {
  const segments: { activity: boolean; messages: DisplayMessage[] }[] = [];
  for (const message of turn.responses) {
    const activity = message.role === "thinking" || message.role === "tool_use";
    const previous = segments.at(-1);
    if (activity && previous?.activity) previous.messages.push(message);
    else segments.push({ activity, messages: [message] });
  }
  return (
    <div className="session-turn">
      {turn.userMessage && <UserBubble text={turn.userMessage.text} />}
      {segments.map((segment, index) => {
        const focused = segment.messages.some((message) => !!focusToolUseId && message.toolUseId === focusToolUseId);
        return segment.activity
          ? <ProcessGroup key={`process:${segment.messages[0].id}:${focused ? focusToolUseId : ""}`} messages={segment.messages} running={running && index === segments.length - 1} focused={focused} timing={timings.get(segment.messages[0].id)} />
          : <MessageBubble key={segment.messages[0].id} message={segment.messages[0]} />;
      })}
    </div>
  );
}

function ProcessGroup({ messages, running, focused, timing }: { messages: DisplayMessage[]; running: boolean; focused: boolean; timing?: ProcessTiming }) {
  const tools = messages.filter((message) => message.role === "tool_use");
  const thinking = messages.some((message) => message.role === "thinking");
  const failed = tools.filter((message) => message.result?.isError).length;
  const incomplete = tools.some((message) => !message.result);
  const active = running;
  const status = active ? "Working" : failed ? "Needs attention" : incomplete ? "Incomplete" : "Explored";
  const description = [thinking ? "reasoning" : "", tools.length ? `${tools.length} tool ${tools.length === 1 ? "call" : "calls"}` : ""].filter(Boolean).join(" · ");
  return (
    <SessionDisclosure className="session-process" active={active} defaultOpen={active || failed > 0 || focused} summary={<>
      {active ? <Circle size={12} className="animate-pulse" /> : failed || incomplete ? <Layers size={14} /> : <Check size={14} />}
      <span>{status} · {description}{failed ? ` · ${failed} failed` : ""}</span>
      {timing && <ProcessElapsedTime timing={timing} running={running} />}
    </>}>
      {messages.map((message) => <MessageBubble key={message.id} message={message} running={running} />)}
    </SessionDisclosure>
  );
}

function ProcessElapsedTime({ timing, running }: { timing: ProcessTiming; running: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  const elapsed = formatElapsedTime((running ? Math.max(now, timing.endedAt) : timing.endedAt) - timing.startedAt);
  return <span className="session-process-duration" title={running ? "Elapsed time" : "Time spent"}>· {elapsed}</span>;
}

function MessageBubble({ message, running = false }: { message: DisplayMessage; running?: boolean }) {
  const sessionId = useContext(SessionContext);
  const onOpenExecution = useContext(OpenExecutionContext);
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
      if (sessionId && onOpenExecution && message.name === "Agent") return <DelegationCard sessionId={sessionId} message={message} running={running} onOpenExecution={onOpenExecution} />;
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
  const resources = useContext(ConversationResourcesContext);
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
          <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={(url, key) => key === "href" && resources && resolveResourcePath(url, resources.skills) ? url : defaultUrlTransform(url)} components={{
            a: ({ href, children }) => <ConversationResourceLink href={href}>{children}</ConversationResourceLink>,
            pre: ({ children }) => <pre><CodeBlockContext.Provider value={true}>{children}</CodeBlockContext.Provider></pre>,
            code: ({ children, className }) => <ConversationResourceLink inlineCode href={typeof children === "string" ? children : undefined}><code className={className}>{children}</code></ConversationResourceLink>,
          }}>{text}</ReactMarkdown>
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
