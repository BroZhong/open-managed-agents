import { useState, useRef, useCallback, type KeyboardEvent } from "react";
import { ArrowUp, Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SessionEvent } from "@/lib/types";

interface MessageInputProps {
  onSend: (text: string) => void;
  disabled?: boolean;
  pendingMessages?: SessionEvent[];
}

export function MessageInput({ onSend, disabled = false, pendingMessages = [] }: MessageInputProps) {
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const adjustHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    const lineHeight = 24;
    const maxHeight = lineHeight * 5;
    textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
  }, []);

  function handleSubmit() {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setText("");
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
      }
    });
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Ignore Enter while an IME is composing (Chinese/Japanese/Korean):
    // pressing Enter to confirm a candidate must never send. keyCode 229 is a
    // belt-and-suspenders guard for browsers that don't set isComposing.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }

  const canSend = text.trim().length > 0 && !disabled;

  return (
    <div className="bg-[var(--color-bg)] px-6 py-4">
      {pendingMessages.length > 0 && (
        <div className="mx-auto mb-2 max-w-3xl space-y-1.5">
          {pendingMessages.map((msg, i) => {
            const data = msg.data as { content: Array<{ type: string; text: string }> };
            const msgText = data.content?.[0]?.text || "";
            return (
              <div key={i} className="flex items-center gap-2 rounded-lg bg-[var(--color-bg-muted)] px-3 py-1.5 text-sm text-[var(--color-fg-muted)]">
                <Clock className="h-3.5 w-3.5 flex-shrink-0 animate-pulse" />
                <span className="truncate">{msgText}</span>
                <span className="ml-auto flex-shrink-0 text-xs text-[var(--color-fg-subtle)]">queued</span>
              </div>
            );
          })}
        </div>
      )}
      <div className="mx-auto max-w-3xl">
        <div className="relative rounded-2xl bg-[var(--color-bg-surface)] shadow-sm ring-1 ring-[var(--color-border)]  focus-within:ring-[var(--color-fg-subtle)] transition-shadow">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              adjustHeight();
            }}
            onKeyDown={handleKeyDown}
            placeholder="Send a message..."
            disabled={disabled}
            rows={1}
            className={cn(
              "w-full resize-none bg-transparent px-4 py-3 pr-12 text-sm leading-6 text-[var(--color-fg)]",
              "placeholder:text-[var(--color-fg-subtle)] focus:outline-none",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
          />
          <button
            onClick={handleSubmit}
            disabled={!canSend}
            className={cn(
              "absolute bottom-2.5 right-3 flex h-7 w-7 items-center justify-center rounded-lg transition-all",
              canSend
                ? "bg-[var(--color-fg)] text-white hover:opacity-80"
                : "bg-[var(--color-bg-muted)] text-[var(--color-fg-subtle)]"
            )}
          >
            <ArrowUp className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
