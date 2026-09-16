import { useState, useRef, useCallback, useEffect, type KeyboardEvent } from "react";
import { ArrowUp, Clock, Square, Sparkles, CornerDownRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { EquippedSkill } from "@/lib/hooks/use-skills";

/** One Queued Input to show above the composer, in the order it will run. */
export interface QueuedInput {
  /** Stable identity — the Host's pending-event id. */
  id: string;
  text: string;
}

interface MessageInputProps {
  onSend: (text: string) => void | Promise<void>;
  disabled?: boolean;
  /** Whether the Host is still accepting the current send request. */
  sending?: boolean;
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
   * primary button becomes Stop. A separate Queue action appears for follow-ups.
   */
  onInterrupt?: () => void;
  /** Whether a Turn of this Session is running right now. */
  running?: boolean;
  model?: string;
}

export function MessageInput({
  onSend,
  disabled = false,
  sending = false,
  queuedInput = [],
  hasMoreQueuedInput = false,
  skills = [],
  onInterrupt,
  running = false,
  model,
}: MessageInputProps) {
  const [text, setText] = useState("");
  const [selectedSkillIndex, setSelectedSkillIndex] = useState(0);
  const [skillPickerOpen, setSkillPickerOpen] = useState(false);
  const [suggestionsDismissed, setSuggestionsDismissed] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const submittingRef = useRef(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const pickerButtonRef = useRef<HTMLButtonElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const skillQuery =
    text === "/"
      ? ""
      : text.match(/^\/skill:([^\s]*)$/)?.[1].toLowerCase();
  const skillSuggestions =
    (!skillPickerOpen && skillQuery === undefined) || suggestionsDismissed
      ? []
      : skills.filter((skill) => skill.name.toLowerCase().startsWith(skillPickerOpen ? "" : skillQuery ?? ""));
  const activeSkillIndex = Math.min(
    selectedSkillIndex,
    Math.max(skillSuggestions.length - 1, 0),
  );

  useEffect(() => {
    if (!skillSuggestions.length) return;
    const dismiss = () => { setSkillPickerOpen(false); setSuggestionsDismissed(true); };
    const outside = (event: Event) => {
      const target = event.target as Node;
      if (!pickerRef.current?.contains(target) && !pickerButtonRef.current?.contains(target)) dismiss();
    };
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") dismiss(); };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [skillSuggestions.length]);

  const adjustHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    const lineHeight = 24;
    // Include the composer toolbar padding when limiting the input to five lines.
    const maxHeight = lineHeight * 5 + 64;
    textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
  }, []);

  async function handleSubmit() {
    const trimmed = text.trim();
    if (!trimmed || disabled || sending || submittingRef.current) return;
    submittingRef.current = true;
    setSendError(null);
    try {
      await onSend(trimmed);
      setText((current) => current === text ? "" : current);
      requestAnimationFrame(() => {
        if (textareaRef.current && !textareaRef.current.value) {
          textareaRef.current.style.height = "auto";
        }
      });
    } catch (error) {
      setSendError(error instanceof Error && error.message
        ? error.message
        : "Failed to send message. Please try again.");
    } finally {
      submittingRef.current = false;
    }
  }

  function selectSkill(index: number) {
    const skill = skillSuggestions[index];
    if (!skill) return;
    setText(`/skill:${skill.name} ${skillPickerOpen ? text.replace(/^\/skill:[^\s]*\s*|^\/$/, "") : ""}`);
    setSkillPickerOpen(false);
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
        setSkillPickerOpen(false);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }

  // Keep Stop reachable while a separate queue action accepts the next prompt.
  const showStop = running && Boolean(onInterrupt);
  const canSend = text.trim().length > 0 && !disabled && !sending;
  const buttonEnabled = showStop || canSend;

  return (
    <div className="composer-area">
      {queuedInput.length > 0 && (
        <div
          className="session-queued-input"
          aria-label="Queued input"
        >
          {queuedInput.map((entry) => (
            <div key={entry.id} className="flex items-center gap-2 rounded-lg bg-[var(--color-bg-muted)] px-3 py-1.5 text-sm text-[var(--color-fg-muted)]">
              <Clock className="h-3.5 w-3.5 flex-shrink-0" />
              <span className="session-queued-text" title={entry.text}>{entry.text}</span>
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
      <div className="session-composer-column">
        {sending && (
          <p role="status" className="mb-2 px-3 text-xs text-[var(--color-fg-subtle)]">
            Sending...
          </p>
        )}
        {sendError && (
          <p role="alert" className="mb-2 px-3 text-sm text-red-500">
            {sendError}
          </p>
        )}
        <div className="message-composer">
          {skillSuggestions.length > 0 && (
            <div
              ref={pickerRef}
              id="equipped-skill-suggestions"
              role="listbox"
              aria-label="Equipped Skills"
              className="absolute bottom-full left-0 right-0 z-20 mb-2 max-h-64 overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-1.5 shadow-lg"
            >
              {skillSuggestions.map((skill, index) => (
                <button
                  id={`equipped-skill-option-${index}`}
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
            aria-label="Message"
            placeholder={disabled ? "This session has ended" : "Send a message..."}
            disabled={disabled || sending}
            rows={1}
            aria-activedescendant={skillSuggestions.length ? `equipped-skill-option-${activeSkillIndex}` : undefined}
            aria-autocomplete="list"
            aria-controls={skillSuggestions.length > 0 ? "equipped-skill-suggestions" : undefined}
            aria-expanded={skillSuggestions.length > 0}
            className={cn(
              "w-full resize-none bg-transparent px-2.5 py-2 text-sm leading-6 text-[var(--color-fg)]",
              "placeholder:text-[var(--color-fg-subtle)] focus:outline-none",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
          />
          <div className="session-composer-toolbar">
            {skills.length > 0 && <button ref={pickerButtonRef} type="button" className="session-skill-picker" aria-label="Choose a Skill" aria-expanded={skillSuggestions.length > 0} disabled={disabled || sending} onClick={() => {
              setSkillPickerOpen(!skillPickerOpen);
              setSuggestionsDismissed(skillPickerOpen);
              setSelectedSkillIndex(0);
              textareaRef.current?.focus();
            }}><Sparkles size={15} /><span>Skills</span></button>}
            <span className="session-composer-model" title={model}>{model?.split("/").at(-1)}</span>
            {showStop && text.trim() && <button type="button" className="session-queue-send" disabled={!canSend} onClick={handleSubmit} aria-label="Queue message" title="Send after the current turn"><CornerDownRight size={15} /><span>Queue</span></button>}
          <button
            type="button"
            aria-label={showStop ? "Stop generating" : "Send message"}
            title={showStop ? "Stop the current turn" : undefined}
            onClick={showStop ? onInterrupt : handleSubmit}
            disabled={!buttonEnabled}
            className={cn(
              "session-send-button flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors",
              buttonEnabled
                ? "bg-[var(--color-fg)] text-white hover:opacity-80"
                : "bg-[var(--color-bg-active)] text-[var(--color-fg-subtle)]"
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
        <p className="session-composer-help">{disabled ? "Start a new session to continue" : running ? "Enter to queue a follow-up · Shift + Enter for a new line" : "Enter to send · Shift + Enter for a new line"}</p>
      </div>
    </div>
  );
}
