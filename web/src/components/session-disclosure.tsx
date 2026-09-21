import { useId, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";

/** Explicit user choice wins over changing activity defaults. Keep content mounted
 * so streaming blocks retain their DOM and nested disclosure state. */
export function SessionDisclosure({ summary, children, defaultOpen = false, active = false, className = "", onActivate, title, id: elementId }: {
  summary: ReactNode;
  children: ReactNode | ((open: boolean) => ReactNode);
  defaultOpen?: boolean;
  active?: boolean;
  className?: string;
  onActivate?: () => void;
  title?: string;
  id?: string;
}) {
  const id = useId();
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? defaultOpen;
  return (
    <div id={elementId} className={`session-disclosure ${className}`} data-active={active}>
      <button type="button" title={title} className="session-disclosure-toggle" aria-expanded={onActivate ? undefined : open} aria-controls={onActivate ? undefined : id} onClick={onActivate ?? (() => setUserOpen(!open))}>
        <span className="session-disclosure-summary">{summary}</span>
        <ChevronRight size={14} className={!onActivate && open ? "rotate-90" : ""} aria-hidden="true" />
      </button>
      {!onActivate && <div id={id} className="session-disclosure-content" hidden={!open}>{typeof children === "function" ? children(open) : children}</div>}
    </div>
  );
}
