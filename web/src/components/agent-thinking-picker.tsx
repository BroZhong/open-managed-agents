import { thinkingLabels, thinkingChoiceLabel, hasUnconfirmedThinkingLevels, type ThinkingLevel, type ThinkingOptions } from "@/lib/hooks/use-thinking-options";

export function AgentThinkingPicker({ value, onChange, options, loading, error, onRetry }: {
  value?: ThinkingLevel;
  onChange: (value?: ThinkingLevel) => void;
  options?: ThinkingOptions;
  loading: boolean;
  error?: string;
  onRetry: () => void;
}) {
  const choices = options?.choices ?? [];
  const effective = value == null ? options?.defaultLevel : options?.resolvedLevels[value];
  const index = Math.max(0, choices.findIndex(choice => choice.value === effective));
  const effectiveLabel = choices[index] ? thinkingChoiceLabel(options, choices[index].label) : "";
  const unconfirmed = hasUnconfirmedThinkingLevels(options);
  const providerControlled = options?.control === "provider";
  const unsupported = choices.length === 1 && choices[0].value === "off";
  const label = providerControlled ? "由接入服务决定" : unsupported ? "不支持思考" : !options ? loading ? "加载中" : "暂不可用" :
    value == null ? unconfirmed ? `自动 · 默认${effectiveLabel}` : `自动 · 模型最高 · ${effectiveLabel}` : value !== effective ? `${thinkingLabels[value]} → ${unconfirmed ? "请求" : ""}${effectiveLabel}` : effectiveLabel;
  const progress = choices.length > 1 ? index / (choices.length - 1) * 100 : 0;

  return <div className="space-y-2 rounded-xl border border-neutral-200 bg-neutral-50/70 px-4 py-3">
    <div className="flex items-center justify-between gap-3">
      <label htmlFor="agent-thinking" className="text-sm font-medium text-neutral-700">思考强度</label>
      <span className="text-xs font-medium text-neutral-500">{label}</span>
    </div>
    {options && !providerControlled ? <div className="relative px-1 pt-1">
      <input id="agent-thinking" type="range" min={0} max={Math.max(0, choices.length - 1)} step={1} value={index}
        aria-label="思考强度" aria-valuetext={label} disabled={loading || unsupported || choices.length < 2}
        onChange={event => onChange(choices[Number(event.target.value)].value)}
        style={{ background: `linear-gradient(to right, var(--color-accent) ${progress}%, var(--color-bg-active) ${progress}%)` }}
        className="thinking-slider w-full" />
      <div className="mt-1 flex justify-between px-0.5 text-[10px] text-neutral-400" aria-hidden="true">
        {choices.map(choice => <span key={choice.value}>{thinkingChoiceLabel(options, choice.label)}</span>)}
      </div>
    </div> : !options ? <p className="text-xs text-neutral-500" role="status">
      {loading ? "正在读取模型档位…" : <><span>{error}</span>{" "}<button type="button" className="underline" onClick={onRetry}>档位读取失败，重试</button></>}
    </p> : null}
    <button type="button" onClick={() => onChange(undefined)} disabled={providerControlled || value == null}
      className="text-xs text-neutral-500 underline disabled:opacity-50" aria-label="重置思考强度">恢复自动</button>
    <p className="text-xs leading-5 text-neutral-500">{providerControlled ? "已保存的等级偏好保留，恢复应用控制后生效。" : unconfirmed ? "基础档位，接入服务支持情况未确认。" : "下个 Turn 生效；自动使用模型支持的最高等级。"}</p>
  </div>;
}
