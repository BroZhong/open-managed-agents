import { useEffect, useRef, useState } from "react";
import { ChevronDown, RotateCcw } from "lucide-react";
import type { ThinkingLevel, ThinkingOptions } from "@/lib/hooks/use-thinking-options";
export type { ThinkingLevel } from "@/lib/hooks/use-thinking-options";
const labels: Record<ThinkingLevel, string> = { off: "关闭", minimal: "极低", low: "低", medium: "中", high: "高", xhigh: "很高", max: "最大" };

export function SessionThinkingPicker({ model, value, inherited, disabled, onChange, options, loading, onRetry }: {
  model?: string;
  options?: ThinkingOptions;
  loading?: boolean;
  onRetry?: () => void;
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
  const choices = options?.choices ?? [];
  const requested = draft ?? inherited;
  const effective = requested == null ? options?.defaultLevel : options?.resolvedLevels[requested];
  const index = Math.max(0, choices.findIndex(choice => choice.value === effective));
  const label = choices[index] ? labels[choices[index].label] : loading ? "加载中" : "暂不可用";
  const modelLabel = (options?.model ?? model)?.split("/").at(-1) ?? "Model";
  const progress = choices.length > 1 ? index / (choices.length - 1) * 100 : 0;
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
      {choices.length > 0 ? <div className="session-thinking-track">
      <input type="range" min={0} max={Math.max(0, choices.length - 1)} step={1} value={index}
        aria-label="Session 思考强度" aria-valuetext={label} disabled={disabled || saving || choices.length < 2}
        className="thinking-slider session-thinking-slider"
        style={{ background: `linear-gradient(to right, var(--color-accent) ${progress}%, var(--color-bg-active) ${progress}%)` }}
        onChange={(event) => setDraft(choices[Number(event.target.value)].value)}
        onPointerUp={(event) => void save(choices[Number(event.currentTarget.value)].value)}
        onKeyUp={(event) => { if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) void save(choices[Number(event.currentTarget.value)].value); }}
        onBlur={(event) => { if (draft !== null) void save(choices[Number(event.currentTarget.value)].value); }} />
      <div className="session-thinking-ticks" aria-hidden="true">
        {choices.map((choice, tick) => <span key={choice.value} style={{ opacity: tick === index ? 0 : 1, background: tick < index ? "#ffffff80" : "#00000030" }} />)}
      </div>
      </div> : <p className="text-center text-xs text-neutral-500" role="status">
        {loading ? "正在读取模型档位…" : <button type="button" className="underline" onClick={onRetry}>档位读取失败，重试</button>}
      </p>}
      <p className="sr-only" aria-live="polite">{saving ? "保存中" : draft === null ? "继承 Agent 设置" : "仅此 Session，下个 Turn 生效"}。按模型支持的等级适配，部分模型无法关闭思考。</p>
    </div>}
    {error && <p role="alert" className="session-thinking-error">{error}</p>}
  </div>;
}
