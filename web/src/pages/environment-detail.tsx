import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ArrowLeft, Copy, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EnvironmentForm } from "@/components/environment-form";
import { BuiltInTag, EnvironmentStatusBadge } from "@/components/environment-badges";
import {
  useCreateEnvironment,
  useDeleteEnvironment,
  useEnvironment,
  useUpdateEnvironment,
  type Environment,
} from "@/lib/hooks/use-environments";

export default function EnvironmentDetailPage() {
  const { id = "" } = useParams();
  const { data: environment, isLoading, error } = useEnvironment(id);
  const update = useUpdateEnvironment(id);
  const copy = useCreateEnvironment();
  const remove = useDeleteEnvironment();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const builtIn = environment?.ownerType === "platform";
  return (
    <div>
      <PageHeader title={environment?.name ?? "Environment"} description={environment?.description || undefined}>
        <Link to="/environments" className="inline-flex items-center gap-2 text-sm text-neutral-500"><ArrowLeft className="h-4 w-4" />返回环境列表</Link>
      </PageHeader>
      <div className="space-y-6 p-6">
        {isLoading ? <p role="status">加载中…</p> : error ? <p role="alert" className="text-sm text-red-600">{error.message}</p> : !environment ? null : editing ? (
          <EnvironmentForm
            environment={environment}
            pending={update.isPending}
            error={update.error}
            submitLabel="保存"
            onCancel={() => setEditing(false)}
            onSubmit={(input) => update.mutate(input, { onSuccess: () => setEditing(false) })}
          />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              {builtIn && <BuiltInTag />}
              <EnvironmentStatusBadge status={environment.status} />
              <div className="ml-auto flex gap-2">
                <Button
                  variant="outline"
                  disabled={copy.isPending}
                  onClick={() => copy.mutate({ from: environment.id }, {
                    onSuccess: (copied) => { toast.success(`已复制为 ${copied.name}`); navigate(`/environments/${copied.id}`); },
                    onError: (failure) => toast.error(failure.message),
                  })}
                >
                  <Copy className="h-4 w-4" />复制为自定义环境
                </Button>
                {!builtIn && (
                  <>
                    <Button variant="outline" onClick={() => { update.reset(); setEditing(true); }}><Pencil className="h-4 w-4" />编辑</Button>
                    <Button variant="outline" aria-label="删除环境" onClick={() => setDeleting(true)}><Trash2 className="h-4 w-4" /></Button>
                  </>
                )}
              </div>
            </div>
            {builtIn && <p className="text-xs text-neutral-500">平台内置环境只读；复制后可修改。</p>}
            <Overview environment={environment} />
            <Variables environment={environment} />
            <section className="space-y-2">
              <h2 className="text-sm font-semibold">初始化脚本</h2>
              {environment.initScript
                ? <pre className="max-h-[480px] overflow-auto rounded-xl bg-neutral-50 p-4 font-mono text-xs">{environment.initScript}</pre>
                : <p className="text-sm text-neutral-500">没有初始化脚本。</p>}
            </section>
          </>
        )}
      </div>
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title="删除环境"
        description={`删除 ${environment?.name ?? ""}？已在使用其镜像的 Sandbox 不受影响。`}
        confirmLabel="Delete"
        onConfirm={() => remove.mutate(id, {
          onSuccess: () => navigate("/environments"),
          onError: (failure) => toast.error(failure.message),
        })}
      />
    </div>
  );
}

function Overview({ environment }: { environment: Environment }) {
  const build = environment.lastBuild;
  return (
    <dl className="grid gap-x-6 gap-y-3 rounded-2xl border border-neutral-200 p-5 text-sm md:grid-cols-[10rem_1fr]">
      <dt className="text-neutral-500">Base Image</dt>
      <dd>{environment.baseImage}</dd>
      <dt className="text-neutral-500">镜像</dt>
      <dd className="break-all font-mono text-xs">{environment.image ?? "尚未构建"}</dd>
      <dt className="text-neutral-500">最近构建</dt>
      <dd>
        {build ? `${build.id} · ${build.status} · ${new Date(build.createdAt).toLocaleString()}` : "无"}
        {build?.errorMessage && <p role="alert" className="mt-1 text-red-600">{build.errorMessage}</p>}
      </dd>
    </dl>
  );
}

/** Secret values never reach the console: only their names. */
function Variables({ environment }: { environment: Environment }) {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold">环境变量</h2>
      {environment.env.length === 0 ? <p className="text-sm text-neutral-500">没有变量。</p> : (
        <table className="w-full text-left text-sm">
          <tbody>
            {environment.env.map((variable) => (
              <tr key={variable.name} className="border-b border-neutral-100 last:border-0">
                <td className="py-2 pr-4 font-mono text-xs">{variable.name}</td>
                <td className="break-all py-2 font-mono text-xs text-neutral-600">
                  {!("secretRef" in variable) ? variable.value : variable.secretRef.source === "platform" ? "平台提供 ••••" : "密钥 ••••"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
