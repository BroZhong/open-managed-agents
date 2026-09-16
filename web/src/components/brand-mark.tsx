import { cn } from "@/lib/utils"

/** OMA's connected-agent mark, kept distinct from OpenGrove's sapling logo. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <span className={cn("brand-mark", className)} aria-hidden="true">
      <svg viewBox="0 0 32 32" fill="none">
        <path d="M10 10h12v12H10z" stroke="currentColor" strokeWidth="1.6" />
        <rect x="5" y="5" width="10" height="10" rx="3" fill="currentColor" />
        <rect x="18" y="7" width="8" height="8" rx="2.5" fill="currentColor" opacity=".5" />
        <rect x="7" y="18" width="8" height="8" rx="2.5" fill="currentColor" opacity=".5" />
        <rect x="17" y="17" width="10" height="10" rx="3" fill="currentColor" />
      </svg>
    </span>
  )
}
