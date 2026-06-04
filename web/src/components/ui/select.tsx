import { useState, useRef, useEffect, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface SelectProps {
  id?: string;
  label?: string;
  value: string;
  onChange: (e: { target: { value: string } }) => void;
  disabled?: boolean;
  className?: string;
  children?: ReactNode;
  placeholder?: string;
}

function parseOptions(children: ReactNode): SelectOption[] {
  const options: SelectOption[] = [];
  const childArray = Array.isArray(children) ? children : [children];
  for (const child of childArray.flat()) {
    if (child && typeof child === "object" && "props" in child) {
      const props = child.props as { value?: string; disabled?: boolean; children?: ReactNode };
      options.push({
        value: props.value ?? "",
        label: typeof props.children === "string" ? props.children : String(props.children ?? ""),
        disabled: props.disabled,
      });
    }
  }
  return options;
}

const Select = ({ className, label, id, value, onChange, disabled, children, placeholder }: SelectProps) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const options = parseOptions(children);

  const selectedLabel = options.find((o) => o.value === value)?.label || placeholder || "Select...";

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    if (isOpen) {
      document.addEventListener("mousedown", handleClick);
      return () => document.removeEventListener("mousedown", handleClick);
    }
  }, [isOpen]);

  useEffect(() => {
    function handleEscape(e: KeyboardEvent) {
      if (e.key === "Escape") setIsOpen(false);
    }
    if (isOpen) {
      document.addEventListener("keydown", handleEscape);
      return () => document.removeEventListener("keydown", handleEscape);
    }
  }, [isOpen]);

  return (
    <div className="space-y-1.5" ref={containerRef}>
      {label && (
        <label htmlFor={id} className="text-sm font-medium text-neutral-700">
          {label}
        </label>
      )}
      <div className="relative">
        <button
          type="button"
          id={id}
          onClick={() => !disabled && setIsOpen(!isOpen)}
          disabled={disabled}
          className={cn(
            "flex h-9 w-full items-center justify-between rounded-md border border-neutral-200 bg-white px-3 py-1.5 text-left text-sm transition-colors",
            "focus:border-neutral-400 focus:outline-none focus:ring-2 focus:ring-neutral-200",
            "disabled:cursor-not-allowed disabled:opacity-50",
            isOpen && "border-neutral-400 ring-2 ring-neutral-200",
            className,
          )}
        >
          <span className={cn("truncate", !value && "text-neutral-400")}>
            {selectedLabel}
          </span>
          <ChevronDown className={cn("h-4 w-4 flex-shrink-0 text-neutral-500 transition-transform", isOpen && "rotate-180")} />
        </button>

        {isOpen && (
          <div className="absolute z-[100] mt-1 max-h-60 w-full overflow-auto rounded-md border border-neutral-200 bg-white py-1 shadow-lg">
            {options.map((option) => (
              <button
                key={option.value}
                type="button"
                disabled={option.disabled}
                onClick={() => {
                  if (!option.disabled) {
                    onChange({ target: { value: option.value } });
                    setIsOpen(false);
                  }
                }}
                className={cn(
                  "flex w-full items-center px-3 py-1.5 text-left text-sm transition-colors",
                  "hover:bg-neutral-100",
                  option.value === value && "bg-neutral-50 font-medium text-neutral-900",
                  option.value !== value && "text-neutral-700",
                  option.disabled && "cursor-not-allowed opacity-50",
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

Select.displayName = "Select";
export { Select };
