import { useEffect, useState, type RefObject } from "react";

/** Measure the panel, since a collapsed sidebar also changes available space. */
export function useCompactPanel(ref: RefObject<HTMLElement | null>, breakpoint: number) {
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      if (element.clientWidth > 0) setCompact(element.clientWidth < breakpoint);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, breakpoint]);
  return compact;
}
