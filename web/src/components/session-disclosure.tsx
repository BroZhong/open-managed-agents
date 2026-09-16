import { useId, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";

/** Explicit user choice wins over changing activity defaults. Keep content mounted
 * so streaming blocks retain their DOM and nested disclosure state. */
export function SessionDisclosure({ summary, children, defaultOpen = false, active = false, className = "" }: {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  active?: boolean;
  className?: string;
}) {
  const id = useId();
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? defaultOpen;
  return (
    <div className={`session-disclosure ${className}`} data-active={active}>
      <button type="button" className="session-disclosure-toggle" aria-expanded={open} aria-controls={id} onClick={() => setUserOpen(!open)}>
        <span className="session-disclosure-summary">{summary}</span>
        <ChevronRight size={14} className={open ? "rotate-90" : ""} aria-hidden="true" />
      </button>
      <div id={id} className="session-disclosure-content" hidden={!open}>{children}</div>
    </div>
  );
}
