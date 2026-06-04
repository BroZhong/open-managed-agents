import { useState } from "react";
import { Brain, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Collapsible } from "@/components/ui/collapsible";

interface ThinkingBlockProps {
  text: string;
  streaming?: boolean;
}

export function ThinkingBlock({ text, streaming = false }: ThinkingBlockProps) {
  const [isOpen, setIsOpen] = useState(streaming);

  const trigger = (
    <div
      className={cn(
        "flex items-center gap-2 rounded-xl border border-[var(--color-border)] px-3 py-2 text-xs text-[var(--color-fg-subtle)] transition-colors hover:bg-[var(--color-bg-muted)]",
      )}
    >
      <Brain className="h-3.5 w-3.5 flex-shrink-0" />
      <span className="flex-1">Thinking...</span>
      <ChevronRight
        className={cn(
          "h-3 w-3 transition-transform duration-200",
          isOpen && "rotate-90",
        )}
      />
    </div>
  );

  return (
    <Collapsible
      trigger={trigger}
      open={isOpen}
      onOpenChange={setIsOpen}
      defaultOpen={streaming}
    >
      <div className="mt-1 rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-muted)] px-3 py-2">
        <p className="whitespace-pre-wrap text-xs italic text-[var(--color-fg-muted)]">
          {text}
          {streaming && (
            <span className="inline-block h-3 w-0.5 animate-pulse bg-[var(--color-fg-subtle)] align-middle" />
          )}
        </p>
      </div>
    </Collapsible>
  );
}
