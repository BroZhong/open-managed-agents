import { useState, useRef, useEffect } from "react";
import { cn } from "@/lib/utils";

interface CollapsibleProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  trigger: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
  className?: string;
}

export function Collapsible({
  open: controlledOpen,
  onOpenChange,
  trigger,
  children,
  defaultOpen = false,
  className,
}: CollapsibleProps) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const isOpen = controlledOpen !== undefined ? controlledOpen : internalOpen;
  const contentRef = useRef<HTMLDivElement>(null);
  const initialOpen = controlledOpen !== undefined ? controlledOpen : defaultOpen;
  const [maxHeight, setMaxHeight] = useState<string>(
    initialOpen ? "none" : "0px",
  );

  useEffect(() => {
    if (isOpen) {
      const el = contentRef.current;
      if (el) {
        setMaxHeight(`${el.scrollHeight}px`);
        // After transition completes, set to "none" to allow dynamic content growth
        const timer = setTimeout(() => setMaxHeight("none"), 200);
        return () => clearTimeout(timer);
      }
    } else {
      // When closing, first set explicit height so transition works
      const el = contentRef.current;
      if (el) {
        setMaxHeight(`${el.scrollHeight}px`);
        // Force reflow then set to 0
        requestAnimationFrame(() => {
          setMaxHeight("0px");
        });
      } else {
        setMaxHeight("0px");
      }
    }
  }, [isOpen]);

  function toggle() {
    const next = !isOpen;
    if (controlledOpen === undefined) {
      setInternalOpen(next);
    }
    onOpenChange?.(next);
  }

  return (
    <div className={cn("w-full", className)}>
      <div onClick={toggle} className="cursor-pointer">
        {trigger}
      </div>
      <div
        ref={contentRef}
        className="overflow-hidden transition-[max-height] duration-200 ease-in-out"
        style={{ maxHeight }}
      >
        {children}
      </div>
    </div>
  );
}
