import { useState, useRef, useCallback, type KeyboardEvent } from "react";
import { ArrowUp, Clock, Square } from "lucide-react";
import { cn } from "@/lib/utils";
import type { EquippedSkill } from "@/lib/hooks/use-skills";

/** One Queued Input to show above the composer, in the order it will run. */
export interface QueuedInput {
  /** Stable identity — the Host's pending-event id, or a local optimistic key. */
  id: string;
  text: string;
}

interface MessageInputProps {
  onSend: (text: string) => void;
  disabled?: boolean;
  /**
   * Input accepted by the Host but not yet executing, oldest first. Reflects the
   * server's queue rather than this component's own sends, so it stays correct
   * between Turns and across a reload (issue #114).
   */
  queuedInput?: QueuedInput[];
  /** Whether more Queued Input exists beyond the listed entries. */
  hasMoreQueuedInput?: boolean;
  skills?: Array<Pick<EquippedSkill, "id" | "name" | "description">>;
  /**
   * Stop the Session's running Turn. When given together with `running`, the
   * button becomes Stop — one control for "the Agent is working" instead of a
   * Send button the user has to guess is inert (issue #113).
   */
  onInterrupt?: () => void;
  /** Whether a Turn of this Session is running right now. */
  running?: boolean;
}

export function MessageInput({
  onSend,
  disabled = false,
  queuedInput = [],
  hasMoreQueuedInput = false,
  skills = [],
  onInterrupt,
  running = false,
}: MessageInputProps) {
  const [text, setText] = useState("");
  const [selectedSkillIndex, setSelectedSkillIndex] = useState(0);
  const [suggestionsDismissed, setSuggestionsDismissed] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const skillQuery =
    text === "/"
      ? ""
      : text.match(/^\/skill:([^\s]*)$/)?.[1].toLowerCase();
  const skillSuggestions =
    skillQuery === undefined || suggestionsDismissed
      ? []
      : skills.filter((skill) => skill.name.toLowerCase().startsWith(skillQuery));
  const activeSkillIndex = Math.min(
    selectedSkillIndex,
    Math.max(skillSuggestions.length - 1, 0),
  );

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

  function selectSkill(index: number) {
    const skill = skillSuggestions[index];
    if (!skill) return;
    setText(`/skill:${skill.name} `);
    setSelectedSkillIndex(0);
    setSuggestionsDismissed(true);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Ignore Enter while an IME is composing (Chinese/Japanese/Korean):
    // pressing Enter to confirm a candidate must never send. keyCode 229 is a
    // belt-and-suspenders guard for browsers that don't set isComposing.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (skillSuggestions.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedSkillIndex((index) => (index + 1) % skillSuggestions.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedSkillIndex(
          (index) => (index - 1 + skillSuggestions.length) % skillSuggestions.length,
        );
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        selectSkill(activeSkillIndex);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSuggestionsDismissed(true);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }

  // While a Turn runs the button's job is to stop it, not to send: a Stop needs
  // no typed text to be meaningful. Enter still queues a message, so typing
  // ahead during a running Turn keeps working.
  const showStop = running && Boolean(onInterrupt);
  const canSend = text.trim().length > 0 && !disabled;
  const buttonEnabled = showStop || canSend;

  return (
    <div className="bg-[var(--color-bg)] px-6 py-4">
      {queuedInput.length > 0 && (
        <div
          className="mx-auto mb-2 max-w-3xl space-y-1.5"
          aria-label="Queued input"
        >
          {queuedInput.map((entry) => (
            <div key={entry.id} className="flex items-center gap-2 rounded-lg bg-[var(--color-bg-muted)] px-3 py-1.5 text-sm text-[var(--color-fg-muted)]">
              <Clock className="h-3.5 w-3.5 flex-shrink-0 animate-pulse" />
              <span className="truncate">{entry.text}</span>
              <span className="ml-auto flex-shrink-0 text-xs text-[var(--color-fg-subtle)]">queued</span>
            </div>
          ))}
          {hasMoreQueuedInput && (
            <p className="px-3 text-xs text-[var(--color-fg-subtle)]">
              More input is queued
            </p>
          )}
        </div>
      )}
      <div className="mx-auto max-w-3xl">
        <div className="relative rounded-2xl bg-[var(--color-bg-surface)] shadow-sm ring-1 ring-[var(--color-border)]  focus-within:ring-[var(--color-fg-subtle)] transition-shadow">
          {skillSuggestions.length > 0 && (
            <div
              id="equipped-skill-suggestions"
              role="listbox"
              aria-label="Equipped Skills"
              className="absolute bottom-full left-0 right-0 z-20 mb-2 max-h-64 overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-1.5 shadow-lg"
            >
              {skillSuggestions.map((skill, index) => (
                <button
                  key={skill.id}
                  type="button"
                  role="option"
                  aria-selected={index === activeSkillIndex}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => selectSkill(index)}
                  className={cn(
                    "flex w-full items-start gap-3 rounded-lg px-3 py-2 text-left",
                    index === activeSkillIndex
                      ? "bg-[var(--color-bg-muted)]"
                      : "hover:bg-[var(--color-bg-muted)]",
                  )}
                >
                  <span className="min-w-0">
                    <span className="block font-mono text-sm font-medium text-[var(--color-fg)]">
                      /skill:{skill.name}
                    </span>
                    {skill.description && (
                      <span className="mt-0.5 block truncate text-xs text-[var(--color-fg-muted)]">
                        {skill.description}
                      </span>
                    )}
                  </span>
                </button>
              ))}
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setSelectedSkillIndex(0);
              setSuggestionsDismissed(false);
              adjustHeight();
            }}
            onKeyDown={handleKeyDown}
            placeholder="Send a message..."
            disabled={disabled}
            rows={1}
            aria-autocomplete="list"
            aria-controls={skillSuggestions.length > 0 ? "equipped-skill-suggestions" : undefined}
            aria-expanded={skillSuggestions.length > 0}
            className={cn(
              "w-full resize-none bg-transparent px-4 py-3 pr-12 text-sm leading-6 text-[var(--color-fg)]",
              "placeholder:text-[var(--color-fg-subtle)] focus:outline-none",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
          />
          <button
            type="button"
            aria-label={showStop ? "Stop generating" : "Send message"}
            title={showStop ? "Stop the current turn" : undefined}
            onClick={showStop ? onInterrupt : handleSubmit}
            disabled={!buttonEnabled}
            className={cn(
              "absolute bottom-2.5 right-3 flex h-7 w-7 items-center justify-center rounded-lg transition-all",
              buttonEnabled
                ? "bg-[var(--color-fg)] text-white hover:opacity-80"
                : "bg-[var(--color-bg-muted)] text-[var(--color-fg-subtle)]"
            )}
          >
            {showStop ? (
              <Square className="h-3 w-3 fill-current" />
            ) : (
              <ArrowUp className="h-4 w-4" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
