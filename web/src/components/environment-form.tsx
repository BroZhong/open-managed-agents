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

export type EnvironmentFormSection = "configuration" | "description" | "initScript" | "env";

export function EnvironmentForm({
  environment,
  section,
  pending,
  error,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  environment?: Environment;
  section?: EnvironmentFormSection;
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
        if (pending) return;
        if (section === "configuration") onSubmit({ name: name.trim(), baseImage });
        else if (section === "description") onSubmit({ description });
        else if (section === "initScript") onSubmit({ initScript });
        else if (section === "env") onSubmit({ env: variablesOf(rows) });
        else onSubmit({ name: name.trim(), description, baseImage, initScript, env: variablesOf(rows) });
      }}
    >
      <fieldset disabled={pending} className="space-y-5">
        {(!section || section === "configuration") && <div className="grid gap-4 md:grid-cols-2">
          <label className="space-y-1.5 text-sm font-medium text-neutral-700">
            <span>Name</span>
            <Input aria-label="Name" value={name} required maxLength={100} onChange={(e) => setName(e.target.value)} />
          </label>
          <div>
            <Select id="environment-base-image" label="Base Image" value={baseImage} onChange={(e) => setBaseImage(e.target.value as EnvironmentBaseImage)}>
              <option value="oma-base">oma-base</option>
              <option value="oma-media">oma-media (with FFmpeg and CJK fonts)</option>
            </Select>
          </div>
          {section && <p className="text-xs text-neutral-500 md:col-span-2">Changing the Base Image starts a new build.</p>}
        </div>}
        {(!section || section === "description") && (
          <Textarea id="environment-description" label="Description" aria-label="Description" value={description} maxLength={1000} onChange={(e) => setDescription(e.target.value)} />
        )}
        {(!section || section === "initScript") && <div className="space-y-1.5">
          <Textarea
            id="environment-init-script"
            label="Init script"
            aria-label="Init script"
            className="min-h-[200px] font-mono text-xs"
            spellCheck={false}
            value={initScript}
            placeholder={"# Runs once per build as root in /home/user; apt-get, pip and npm are available\napt-get install -y jq"}
            onChange={(e) => setInitScript(e.target.value)}
          />
          <p className="text-xs text-neutral-500">
            Write a variable every command should inherit from the image to /etc/profile.d/*.sh, as <code>{'export FOO="${FOO:-value}"'}</code>. Changing the script or Base Image rebuilds; a new name, description or variables apply at once, without a build.
          </p>
        </div>}
        {(!section || section === "env") && <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-neutral-700">Variables</legend>
          {section && <p className="text-xs text-neutral-500">Variable changes apply to subsequent commands without a build.</p>}
          {rows.length === 0 && <p className="text-xs text-neutral-500">No variables. The platform defaults PIP_INDEX_URL and NPM_CONFIG_REGISTRY can be overridden.</p>}
          {rows.map((r) => (
            <div key={r.id} className="flex items-center gap-2">
              <Input aria-label="Variable name" className="max-w-[16rem] font-mono text-xs" value={r.name} onChange={(e) => edit(r.id, { name: e.target.value })} />
              {r.kind === "platform" ? (
                <span className="flex-1 text-xs text-neutral-500">Provided by platform ••••</span>
              ) : (
                <Input
                  aria-label={`Value of ${r.name || (r.kind === "secret" ? "secret" : "variable")}`}
                  className="flex-1 font-mono text-xs"
                  type={r.kind === "secret" ? "password" : "text"}
                  autoComplete="off"
                  value={r.value}
                  placeholder={r.kind === "secret" ? (r.key ? "Stored ••••; leave blank to keep it" : "Secret value, never shown again") : "Value"}
                  onChange={(e) => edit(r.id, { value: e.target.value })}
                />
              )}
              {r.kind === "secret" && <span className="text-xs text-neutral-500">Secret</span>}
              <Button type="button" variant="ghost" size="icon" aria-label={`Remove variable ${r.name}`} onClick={() => setRows((current) => current.filter((x) => x.id !== r.id))}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setRows((current) => [...current, row({ kind: "plain", name: "", value: "" })])}>
              <Plus className="h-3.5 w-3.5" />Add variable
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setRows((current) => [...current, row({ kind: "secret", name: "", value: "" })])}>
              <Plus className="h-3.5 w-3.5" />Add secret
            </Button>
          </div>
        </fieldset>}
      </fieldset>
      {error && <p role="alert" className="text-sm text-red-600">{error.message}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" disabled={pending} onClick={onCancel}>Cancel</Button>
        <Button type="submit" disabled={pending}>{pending ? "Saving…" : submitLabel}</Button>
      </div>
    </form>
  );
}
