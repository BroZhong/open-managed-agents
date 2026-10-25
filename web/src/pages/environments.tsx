import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { Boxes, Copy, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EnvironmentForm } from "@/components/environment-form";
import { BuiltInTag, EnvironmentStatusBadge } from "@/components/environment-badges";
import {
  useCreateEnvironment,
  useDeleteEnvironment,
  useEnvironments,
  type EnvironmentSummary,
} from "@/lib/hooks/use-environments";

export default function EnvironmentsPage() {
  const environments = useEnvironments();
  const create = useCreateEnvironment();
  const remove = useDeleteEnvironment();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<EnvironmentSummary | null>(null);
  const copy = (environment: EnvironmentSummary) =>
    create.mutate({ from: environment.id }, {
      onSuccess: (copied) => {
        toast.success(`已复制为 ${copied.name}`);
        navigate(`/environments/${copied.id}`);
      },
      onError: (error) => toast.error(error.message),
    });
  return (
    <div>
      <PageHeader title="Environment" description="Sandbox 运行的环境：Base Image、初始化脚本和环境变量，构建一次成镜像。">
        {!creating && (
          <Button onClick={() => { create.reset(); setCreating(true); }}>
            <Plus className="h-4 w-4" />
            新建环境
          </Button>
        )}
      </PageHeader>
      <div className="space-y-6 p-6">
        {creating && (
          <EnvironmentForm
            pending={create.isPending}
            error={create.error}
            submitLabel="创建"
            onCancel={() => setCreating(false)}
            onSubmit={(input) => create.mutate(input, { onSuccess: (created) => navigate(`/environments/${created.id}`) })}
          />
        )}
        {environments.isLoading && <p role="status">加载中…</p>}
        {environments.error && <p role="alert" className="text-sm text-red-600">{environments.error.message}</p>}
        {environments.data?.length === 0 && (
          <div className="rounded-2xl border border-dashed border-neutral-200 px-6 py-16 text-center">
            <Boxes className="mx-auto mb-3 h-8 w-8 text-neutral-400" />
            <p>还没有环境。</p>
          </div>
        )}
        <div className="grid gap-4 lg:grid-cols-2">
          {environments.data?.map((environment) => (
            <section key={environment.id} aria-label={environment.name} className="rounded-2xl border border-neutral-200 p-5">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link to={`/environments/${environment.id}`} className="font-semibold hover:underline">{environment.name}</Link>
                    {environment.ownerType === "platform" && <BuiltInTag />}
                    <EnvironmentStatusBadge status={environment.status} />
                  </div>
                  <p className="mt-1 text-xs text-neutral-500">{environment.baseImage}</p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button variant="ghost" size="icon" aria-label={`复制 ${environment.name}`} title="复制为自定义环境" disabled={create.isPending} onClick={() => copy(environment)}>
                    <Copy className="h-4 w-4" />
                  </Button>
                  {environment.ownerType === "tenant" && (
                    <Button variant="ghost" size="icon" aria-label={`删除 ${environment.name}`} onClick={() => setDeleting(environment)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </div>
              {environment.description && <p className="mt-3 text-sm text-neutral-600">{environment.description}</p>}
              <p className="mt-3 text-xs text-neutral-500">更新于 {new Date(environment.updatedAt).toLocaleString()}</p>
            </section>
          ))}
        </div>
      </div>
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => { if (!open) setDeleting(null); }}
        title="删除环境"
        description={`删除 ${deleting?.name ?? ""}？已在使用其镜像的 Sandbox 不受影响。`}
        confirmLabel="Delete"
        onConfirm={() => {
          if (deleting) remove.mutate(deleting.id, { onError: (error) => toast.error(error.message) });
        }}
      />
    </div>
  );
}
