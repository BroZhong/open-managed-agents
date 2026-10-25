import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type {
  Environment,
  EnvironmentBaseImage,
  EnvironmentInput,
  EnvironmentVariableInput,
} from "@/lib/hooks/use-environments";

/**
 * One row of the variable editor. A stored secret (`key` set) is never shown;
 * left blank it is sent without a value, so the Host keeps it.
 */
interface VariableRow {
  id: number;
  kind: "plain" | "secret" | "platform";
  name: string;
  value: string;
  key?: string;
}

let rowIds = 0;
const row = (fields: Omit<VariableRow, "id">): VariableRow => ({ id: ++rowIds, ...fields });

function rowsOf(env: Environment["env"]): VariableRow[] {
  return env.map((variable) =>
    "secretRef" in variable
      ? row({ kind: variable.secretRef.source === "platform" ? "platform" : "secret", name: variable.name, value: "", key: variable.secretRef.key })
      : row({ kind: "plain", name: variable.name, value: variable.value }),
  );
}

function variablesOf(rows: VariableRow[]): EnvironmentVariableInput[] {
  return rows.map((r) => {
    const name = r.name.trim();
    if (r.kind === "plain") return { name, value: r.value };
    if (r.kind === "platform") return { name, secretRef: { source: "platform", key: r.key! } };
    return { name, secretRef: { source: "environment", key: r.key ?? name }, ...(r.value || !r.key ? { value: r.value } : {}) };
  });
}

export function EnvironmentForm({
  environment,
  pending,
  error,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  environment?: Environment;
  pending: boolean;
  error?: Error | null;
  submitLabel: string;
  onSubmit: (input: EnvironmentInput) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(environment?.name ?? "");
  const [description, setDescription] = useState(environment?.description ?? "");
  const [baseImage, setBaseImage] = useState<EnvironmentBaseImage>(environment?.baseImage ?? "oma-base");
  const [initScript, setInitScript] = useState(environment?.initScript ?? "");
  const [rows, setRows] = useState<VariableRow[]>(() => rowsOf(environment?.env ?? []));
  const edit = (id: number, patch: Partial<VariableRow>) => setRows((current) => current.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  return (
    <form
      className="space-y-5 rounded-2xl border border-neutral-200 p-5"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit({ name: name.trim(), description, baseImage, initScript, env: variablesOf(rows) });
      }}
    >
      <div className="grid gap-4 md:grid-cols-2">
        <label className="space-y-1.5 text-sm font-medium text-neutral-700">
          <span>名称</span>
          <Input aria-label="名称" value={name} required maxLength={100} onChange={(e) => setName(e.target.value)} />
        </label>
        <div>
          <Select id="environment-base-image" label="Base Image" value={baseImage} onChange={(e) => setBaseImage(e.target.value as EnvironmentBaseImage)}>
            <option value="oma-base">oma-base</option>
            <option value="oma-media">oma-media（含 FFmpeg 与中文字体）</option>
          </Select>
        </div>
      </div>
      <label className="block space-y-1.5 text-sm font-medium text-neutral-700">
        <span>描述</span>
        <Input aria-label="描述" value={description} maxLength={1000} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <div className="space-y-1.5">
        <Textarea
          id="environment-init-script"
          label="初始化脚本"
          aria-label="初始化脚本"
          className="min-h-[200px] font-mono text-xs"
          spellCheck={false}
          value={initScript}
          placeholder={"# 以 root 在 /home/user 中执行一次，可使用 apt-get、pip、npm\napt-get install -y jq"}
          onChange={(e) => setInitScript(e.target.value)}
        />
        <p className="text-xs text-neutral-500">
          命令要继承的变量请写入 /etc/profile.d/*.sh，例如 <code>{'export FOO="${FOO:-value}"'}</code>。修改脚本或 Base Image 会重新构建；修改名称、描述与变量立即生效，不会构建。
        </p>
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-neutral-700">环境变量</legend>
        {rows.length === 0 && <p className="text-xs text-neutral-500">没有变量。平台默认的 PIP_INDEX_URL、NPM_CONFIG_REGISTRY 可被覆盖。</p>}
        {rows.map((r) => (
          <div key={r.id} className="flex items-center gap-2">
            <Input aria-label="变量名" className="max-w-[16rem] font-mono text-xs" value={r.name} onChange={(e) => edit(r.id, { name: e.target.value })} />
            {r.kind === "platform" ? (
              <span className="flex-1 text-xs text-neutral-500">平台提供 ••••</span>
            ) : (
              <Input
                aria-label={r.kind === "secret" ? `${r.name || "密钥"} 的值` : `${r.name || "变量"} 的值`}
                className="flex-1 font-mono text-xs"
                type={r.kind === "secret" ? "password" : "text"}
                autoComplete="off"
                value={r.value}
                placeholder={r.kind === "secret" ? (r.key ? "已保存 ••••，留空保持不变" : "密钥值，保存后不再显示") : "值"}
                onChange={(e) => edit(r.id, { value: e.target.value })}
              />
            )}
            {r.kind === "secret" && <span className="text-xs text-neutral-500">密钥</span>}
            <Button type="button" variant="ghost" size="icon" aria-label={`删除变量 ${r.name}`} onClick={() => setRows((current) => current.filter((x) => x.id !== r.id))}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => setRows((current) => [...current, row({ kind: "plain", name: "", value: "" })])}>
            <Plus className="h-3.5 w-3.5" />添加变量
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => setRows((current) => [...current, row({ kind: "secret", name: "", value: "" })])}>
            <Plus className="h-3.5 w-3.5" />添加密钥
          </Button>
        </div>
      </fieldset>
      {error && <p role="alert" className="text-sm text-red-600">{error.message}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>取消</Button>
        <Button type="submit" disabled={pending}>{pending ? "保存中…" : submitLabel}</Button>
      </div>
    </form>
  );
}
