import { useState, useRef, useCallback, type KeyboardEvent } from "react";
import { ArrowUp, Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SessionEvent } from "@/lib/types";
import type { EquippedSkill } from "@/lib/hooks/use-skills";

interface MessageInputProps {
  onSend: (text: string) => void;
  disabled?: boolean;
  pendingMessages?: SessionEvent[];
  skills?: Array<Pick<EquippedSkill, "id" | "name" | "description">>;
}

export function MessageInput({
  onSend,
  disabled = false,
  pendingMessages = [],
  skills = [],
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
            aria-label="Send message"
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
