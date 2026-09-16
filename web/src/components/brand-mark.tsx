import { cn } from "@/lib/utils"

/** OMA's waving cloud mascot. The approved artwork lives in public/brand. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <span className={cn("brand-mark", className)} aria-hidden="true">
      <img src="/brand/cloud-logo.png" alt="" width="1254" height="1254" draggable={false} />
    </span>
  )
}
