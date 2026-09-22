import { useEffect, useRef, useState, useMemo, useId, createContext, useContext } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { AlertCircle, ChevronDown, ChevronRight, Circle, Check, Layers, Users } from "lucide-react";
import type { SessionDelta, SessionEvent } from "@/lib/types";
import {
  processEventsToMessages,
  shouldShowTypingIndicator,
  type DisplayMessage,
} from "@/lib/conversation-projection";
import { ConversationResourceLink } from "@/components/conversation-resource-link";
import { ConversationResourcesContext, CodeBlockContext, type ConversationResources } from "@/lib/conversation-resources";
import { SessionLoading } from "@/components/session-loading";
import { ThinkingBlock } from "@/components/thinking-block";
import { SessionDisclosure } from "@/components/session-disclosure";
import { ToolCard } from "@/components/tool-card";

import { DelegationCard } from "@/components/delegation-card";
import type { DelegationExecution } from "@/lib/delegations";
import { resolveResourcePath } from "@/lib/resource-path";
import { groupMessagesIntoTurns, type ConversationTurn } from "@/lib/conversation-turns";
import { processTimings, formatElapsedTime, type ProcessTiming } from "@/lib/process-timing";
const SessionContext = createContext("");
const OpenExecutionContext = createContext<((execution: DelegationExecution) => void) | undefined>(undefined);

interface ConversationViewProps {
  /** Noninteractive, clipped owner share preview. */
  preview?: boolean;
  loading?: boolean;
  loadError?: string;
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
  preview = false,
  loading = false,
  loadError,
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
    () => groupMessagesIntoTurns(messages, events, sessionStatus),
    [messages, events, sessionStatus],
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
    if (!preview && followBottomRef.current) bottomRef.current?.scrollIntoView({ behavior: "instant" });
  }, [messages, preview]);

  // Images, tables and streaming text can grow without adding a message.
  useEffect(() => {
    if (preview || !contentRef.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (!preview && followBottomRef.current) bottomRef.current?.scrollIntoView({ behavior: "instant" });
    });
    observer.observe(contentRef.current);
    return () => observer.disconnect();
  }, [preview]);

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
          {loading && <SessionLoading />}
          {loadError && <p role="alert" className="py-8 text-center text-sm text-[var(--color-fg-muted)]">{loadError}</p>}
          {!loading && !loadError && messages.length === 0 && (
            <div className="session-welcome"><h2>What would you like to work on?</h2><p>Send a message to start the conversation.</p></div>
          )}
          {turns.map((turn) => (
            <TurnBlock
              key={turn.id}
              turn={turn}
              running={turn.running}
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

function TurnBlock({ turn, running, focusToolUseId, timings }: { turn: ConversationTurn; running: boolean; focusToolUseId?: string; timings: Map<string, ProcessTiming> }) {
  const contentId = useId();
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const segments: { activity: boolean; messages: DisplayMessage[] }[] = [];
  for (const message of turn.responses) {
    const activity = message.role === "thinking" || message.role === "tool_use" || message.role === "notification";
    const previous = segments.at(-1);
    if (activity && previous?.activity) previous.messages.push(message);
    else segments.push({ activity, messages: [message] });
  }
  const lastMessage = turn.responses.at(-1);
  const collapsible = turn.completed && lastMessage?.role === "assistant" && !lastMessage.aborted && segments.length > 1;
  const focusedTurn = turn.responses.some((message) => !!focusToolUseId && message.toolUseId === focusToolUseId);
  const open = expanded ?? focusedTurn;
  return (
    <div className="session-turn">
      {turn.userMessage && <UserBubble text={turn.userMessage.text} />}
      {collapsible && <div className="session-turn-summary session-disclosure">
        <button type="button" className="session-disclosure-toggle" aria-expanded={open}
          aria-controls={segments.slice(0, -1).map((_, index) => `${contentId}-${index}`).join(" ")}
          onClick={() => setExpanded(!open)}>
          <span>{turn.timing ? `Worked for ${formatElapsedTime(turn.timing.endedAt - turn.timing.startedAt)}` : "View activity"}</span>
          <ChevronRight size={14} className={open ? "rotate-90" : ""} aria-hidden="true" />
        </button>
      </div>}
      {segments.map((segment, index) => {
        const focused = segment.messages.some((message) => !!focusToolUseId && message.toolUseId === focusToolUseId);
        return <div key={segment.messages[0].id} id={`${contentId}-${index}`} className="session-turn-segment"
          hidden={collapsible && !open && index < segments.length - 1}>
          {segment.activity
          ? <ProcessGroup key={focused ? focusToolUseId : "process"} messages={segment.messages} running={running && index === segments.length - 1} focused={focused} timing={timings.get(segment.messages[0].id)} />
          : <MessageBubble message={segment.messages[0]} running={running} />}
        </div>;
      })}
    </div>
  );
}

function ProcessGroup({ messages, running, focused, timing }: { messages: DisplayMessage[]; running: boolean; focused: boolean; timing?: ProcessTiming }) {
  const tools = messages.filter((message) => message.role === "tool_use");
  const thinking = messages.some((message) => message.role === "thinking");
  const notifications = messages.filter((message) => message.role === "notification");
  const failed = messages.filter((message) => message.result?.isError).length;
  const incomplete = tools.some((message) => !message.result);
  const active = running;
  const status = active ? "Working" : failed ? "Needs attention" : incomplete ? "Incomplete" : "Explored";
  const description = [thinking ? "reasoning" : "", tools.length ? `${tools.length} tool ${tools.length === 1 ? "call" : "calls"}` : "", notifications.length ? `${notifications.length} subagent ${notifications.length === 1 ? "result" : "results"}` : ""].filter(Boolean).join(" · ");
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
      return <SessionDisclosure className={`session-tool ${message.result?.isError ? "session-tool-error" : ""}`}
        defaultOpen={message.result?.isError} summary={<>
          <Users size={14} /><span className="session-tool-label">Subagent result</span>
          {message.status && <span className="session-tool-detail"> · {message.status}</span>}
          <span className="session-tool-status">{message.result?.isError ? <AlertCircle size={13} /> : <Check size={13} />}</span>
        </>}>
        <AssistantBubble text={message.text} />
      </SessionDisclosure>;
    case "compaction": {
      const data = message.compaction!;
      const status = !running && ["started", "retrying"].includes(data.status) ? "interrupted" : data.status;
      return <SessionDisclosure className="session-tool" summary={<>
        <span className="session-tool-label">Context compaction</span>
        <span className="session-tool-detail"> · {status} · {data.reason ?? "unknown trigger"}</span>
      </>}>
        <div className="space-y-2 text-sm">
          <p>Before: {data.tokensBefore ?? "unavailable"} tokens ({data.tokensBeforeSource === "usage" ? "measured usage" : "SDK estimate"}) · After: {data.estimatedTokensAfter ?? "unavailable"} tokens (estimated)</p>
          <p>Model retry: {data.willRetry === undefined ? "unavailable" : data.willRetry ? "yes" : "no"}{data.attempt ? ` · Summary retries: ${data.attempt}/${data.maxAttempts}` : ""}</p>
          {data.retryErrors?.map((error, index) => <p key={index}>Summary retry {index + 1}: {error}</p>)}
          {data.errorMessage && <p role="alert">{data.errorMessage}</p>}
          {data.completionWarning && <p role="alert">Summary saved. {data.completionWarning}</p>}
          {data.summary && <p className="whitespace-pre-wrap">{data.summary}</p>}
          {data.usage !== undefined ? <div>Summary usage (measured)<pre className="overflow-auto text-xs">{JSON.stringify(data.usage, null, 2)}</pre></div> : <p>Summary usage: unavailable</p>}
        </div>
      </SessionDisclosure>;
    }
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
          sessionId={sessionId}
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
            ...(resources?.shared ? { img: ({ src, alt }: { src?: string; alt?: string }) => <ConversationResourceLink href={src}>{alt || "Workspace image"}</ConversationResourceLink> } : {}),
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
