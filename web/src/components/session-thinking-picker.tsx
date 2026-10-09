import { useEffect, useRef, useState } from "react";
import { ChevronDown, RotateCcw } from "lucide-react";
import type { Agent } from "@/lib/hooks/use-agents";

export type ThinkingLevel = NonNullable<Agent["thinking"]>;
const levels: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const labels = ["关闭", "极低", "低", "中", "高", "很高", "最大"];

export function SessionThinkingPicker({ model, value, inherited, disabled, onChange }: {
  model?: string;
  value?: ThinkingLevel | null;
  inherited?: ThinkingLevel | null;
  disabled?: boolean;
  onChange: (value: ThinkingLevel | null) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<ThinkingLevel | null>(value ?? null);
  const [lastValue, setLastValue] = useState(value ?? null);
  if ((value ?? null) !== lastValue) {
    setLastValue(value ?? null);
    setDraft(value ?? null);
  }
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const inFlight = useRef(false);
  const saved = useRef(value ?? null);
  useEffect(() => { saved.current = value ?? null; }, [value]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setOpen(false); trigger.current?.focus(); }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  async function save(next: ThinkingLevel | null) {
    if (disabled || inFlight.current || next === saved.current) return;
    inFlight.current = true;
    setSaving(true);
    setError(undefined);
    try {
      await onChange(next);
      saved.current = next;
      setDraft(next);
    } catch {
      setDraft(saved.current);
      setError("保存失败，请重试");
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }
  const effective = draft ?? inherited ?? "max";
  const index = levels.indexOf(effective);
  const label = labels[index];
  const modelLabel = model?.split("/").at(-1) ?? "Model";
  return <div ref={root} className="session-thinking-control">
    <button ref={trigger} type="button" className="session-thinking-trigger" disabled={disabled || saving}
      aria-label={`思考强度：${label}${draft === null ? "，继承 Agent" : ""}`} aria-haspopup="dialog" aria-expanded={open}
      onClick={() => setOpen(!open)}>
      <span className="truncate" title={model}>{modelLabel}</span><span>{label}</span><ChevronDown size={14} />
    </button>
    {open && <div role="dialog" aria-label="Session 思考强度" className="session-thinking-popover">
      <button type="button" className="session-thinking-reset" title="恢复 Agent 设置" aria-label="恢复 Agent 设置"
        disabled={disabled || saving || draft === null} onClick={() => void save(null)}><RotateCcw size={16} /></button>
      <div className="session-thinking-heading" title={draft === null ? "继承 Agent 设置" : "仅此 Session · 下个 Turn 生效"}>{label}</div>
      <p className="session-thinking-model">{modelLabel}</p>
      <div className="session-thinking-track">
      <input type="range" min={0} max={levels.length - 1} step={1} value={index}
        aria-label="Session 思考强度" aria-valuetext={label} disabled={disabled || saving}
        className="thinking-slider session-thinking-slider"
        style={{ background: `linear-gradient(to right, var(--color-accent) ${index / (levels.length - 1) * 100}%, var(--color-bg-active) ${index / (levels.length - 1) * 100}%)` }}
        onChange={(event) => setDraft(levels[Number(event.target.value)])}
        onPointerUp={(event) => void save(levels[Number(event.currentTarget.value)])}
        onKeyUp={(event) => { if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) void save(levels[Number(event.currentTarget.value)]); }}
        onBlur={(event) => { if (draft !== null) void save(levels[Number(event.currentTarget.value)]); }} />
      <div className="session-thinking-ticks" aria-hidden="true">
        {levels.map((level, tick) => <span key={level} style={{ opacity: tick === index ? 0 : 1, background: tick < index ? "#ffffff80" : "#00000030" }} />)}
      </div>
      </div>
      <p className="sr-only" aria-live="polite">{saving ? "保存中" : draft === null ? "继承 Agent 设置" : "仅此 Session，下个 Turn 生效"}。按模型支持的等级适配，部分模型无法关闭思考。</p>
    </div>}
    {error && <p role="alert" className="session-thinking-error">{error}</p>}
  </div>;
}
