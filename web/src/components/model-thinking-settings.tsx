import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { useCapabilityReferences, useProviderThinkingOptions, type ProviderModel } from "@/lib/hooks/use-model-providers";
import { thinkingLabels, thinkingChoiceLabel, hasUnconfirmedThinkingLevels } from "@/lib/hooks/use-thinking-options";

export function ModelThinkingSettings({ api, model, onChange }: {
  api: string;
  model: ProviderModel;
  onChange: (patch: Partial<ProviderModel>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const catalog = useCapabilityReferences(api, model.id, open);
  const preview = useProviderThinkingOptions(api, model, open);
  const options = preview.isError ? undefined : preview.data;
  const reference = model.capabilityReference ?? (model.catalogProvider ? { provider: model.catalogProvider, modelId: model.id } : undefined);
  const selected = reference ? `${reference.provider}/${reference.modelId}` : "";
  const available = catalog.data?.data ?? [];
  const visible = available.filter(entry => `${entry.name} ${entry.provider} ${entry.modelId}`.toLowerCase().includes(search.toLowerCase())).slice(0, 100);
  const selectedEntry = available.find(entry => `${entry.provider}/${entry.modelId}` === selected);
  if (selectedEntry && !visible.includes(selectedEntry)) visible.unshift(selectedEntry);
  const sources = { manual: "手动参照", upstream: "接入服务声明", catalog: "自动识别", default: "基础档位" };
  const unsupported = options?.choices.length === 1 && options.choices[0].value === "off";
  const unconfirmed = hasUnconfirmedThinkingLevels(options);

  return <details className="space-y-3 border-t border-neutral-100 pt-3" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer">高级思考设置</summary>
    {open && <div className="space-y-3">
      {api === "anthropic-messages" && <>
        <Select id={`thinking-profile-${model.id}`} label="思考档位方案" value={model.thinkingProfile ?? ""}
          onChange={event => onChange({ thinkingProfile: event.target.value === "anthropic-adaptive" ? "anthropic-adaptive" : undefined })}>
          <option value="">按能力参照 / 自动识别</option>
          <option value="anthropic-adaptive">Anthropic Adaptive · 五档</option>
        </Select>
        {model.thinkingProfile && <p>low / medium / high / xhigh / max；持续思考，自动使用 max。</p>}
      </>}
      <p>能力参照只影响思考能力；请求仍使用当前模型 ID 和接入服务。</p>
      {preview.isFetching ? <p role="status">正在读取思考能力…</p> : options ? <div className="space-y-1" role="status">
        <p>{options.profile ? "手动配置" : sources[options.source ?? "default"]} · {unsupported ? "不支持思考" : `${unconfirmed ? "默认请求" : "自动使用"}${thinkingLabels[options.defaultLevel]}`}</p>
        {unconfirmed && <p>具体档位未确认；可选择同协议能力参照。</p>}
        {!unsupported && <p>{options.choices.map(choice => thinkingChoiceLabel(options, choice.label)).join(" · ")}</p>}
        {options.reference && <p className="break-all">{options.reference.provider}/{options.reference.modelId}</p>}
      </div> : <p role="alert">{preview.error?.message}{" "}<button type="button" className="underline" onClick={() => void preview.refetch()}>重试能力查询</button></p>}
      {!reference && options?.recommendations?.map(candidate => <div key={`${candidate.provider}/${candidate.modelId}`} className="space-y-1 rounded-md bg-neutral-50 p-2">
        <p>推荐 {candidate.name} · {candidate.reason}</p>
        <button type="button" className="underline" onClick={() => onChange({ capabilityReference: { provider: candidate.provider, modelId: candidate.modelId }, catalogProvider: undefined })}>使用 {candidate.name}</button>
      </div>)}
      <Input aria-label={`Search capability references for ${model.id}`} placeholder="搜索同协议能力参照" value={search} onChange={event => setSearch(event.target.value)} />
      <Select id={`capability-reference-${model.id}`} label="Capability reference" value={selected} disabled={catalog.isFetching}
        onChange={event => {
          const next = available.find(entry => `${entry.provider}/${entry.modelId}` === event.target.value);
          onChange({ capabilityReference: next ? { provider: next.provider, modelId: next.modelId } : undefined, catalogProvider: undefined });
        }}>
        <option value="">自动识别</option>
        {visible.map(entry => <option key={`${entry.provider}/${entry.modelId}`} value={`${entry.provider}/${entry.modelId}`}>{`${entry.name} · ${entry.provider}/${entry.modelId}`}</option>)}
        {reference && !selectedEntry && <option value={selected}>{`${selected}（当前参照）`}</option>}
      </Select>
      {catalog.isError && <p role="alert">{catalog.error.message}{" "}<button type="button" className="underline" onClick={() => void catalog.refetch()}>重试目录查询</button></p>}
      {reference && <button type="button" className="underline" onClick={() => onChange({ capabilityReference: undefined, catalogProvider: undefined })}>{model.thinkingProfile ? "清除能力参照" : "清除参照，恢复自动识别"}</button>}
    </div>}
  </details>;
}
