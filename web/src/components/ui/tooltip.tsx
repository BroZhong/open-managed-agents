import { cn } from "@/lib/utils"
import { type HTMLAttributes, forwardRef } from "react"

interface TooltipProps extends HTMLAttributes<HTMLDivElement> {
  content: string
}

const Tooltip = forwardRef<HTMLDivElement, TooltipProps>(
  ({ content, children, className, ...props }, ref) => {
    return (
      <div ref={ref} title={content} className={cn("relative", className)} {...props}>
        {children}
      </div>
    )
  }
)
Tooltip.displayName = "Tooltip"
export { Tooltip }
