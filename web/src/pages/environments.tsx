import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { Boxes, Copy, Plus, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { EnvironmentForm } from "@/components/environment-form";
import { BuiltInTag, EnvironmentStatusBadge } from "@/components/environment-badges";
import { CopyEnvironmentDialog, DeleteEnvironmentDialog } from "@/components/environment-actions";
import {
  useCopyEnvironment,
  useCreateEnvironment,
  useEnvironments,
  type EnvironmentSummary,
} from "@/lib/hooks/use-environments";

export default function EnvironmentsPage() {
  const environments = useEnvironments();
  const create = useCreateEnvironment();
  const copying = useCopyEnvironment();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [forking, setForking] = useState<EnvironmentSummary | null>(null);
  const [deleting, setDeleting] = useState<EnvironmentSummary | null>(null);
  return (
    <div>
      <PageHeader title="Environments" description="What Sandboxes run: a Base Image, an init script and variables, built once into an image.">
        {!creating && (
          <Button onClick={() => { create.reset(); setCreating(true); }}>
            <Plus className="h-4 w-4" />
            New Environment
          </Button>
        )}
      </PageHeader>
      <div className="space-y-6 p-6">
        {creating && (
          <EnvironmentForm
            pending={create.isPending}
            error={create.error}
            submitLabel="Create"
            onCancel={() => setCreating(false)}
            onSubmit={(input) => create.mutate(input, { onSuccess: (created) => navigate(`/environments/${created.id}`) })}
          />
        )}
        {environments.isLoading && <p role="status">Loading…</p>}
        {environments.error && <p role="alert" className="text-sm text-red-600">{environments.error.message}</p>}
        {environments.data?.length === 0 && (
          <div className="rounded-2xl border border-dashed border-neutral-200 px-6 py-16 text-center">
            <Boxes className="mx-auto mb-3 h-8 w-8 text-neutral-400" />
            <p>No Environments yet.</p>
          </div>
        )}
        <div className="grid gap-4 lg:grid-cols-2">
          {environments.data?.map((environment) => (
            <section key={environment.id} aria-label={environment.name} className="relative rounded-2xl border border-neutral-200 p-5 transition-colors hover:border-neutral-300 hover:bg-neutral-50/50">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link to={`/environments/${environment.id}`} className="font-semibold after:absolute after:inset-0 after:rounded-2xl focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-[var(--color-accent)]">{environment.name}</Link>
                    {environment.ownerType === "platform" && <BuiltInTag />}
                    <EnvironmentStatusBadge status={environment.status} />
                  </div>
                  <p className="mt-1 text-xs text-neutral-500">{environment.baseImage}</p>
                </div>
                <div className="relative z-10 flex shrink-0 gap-1">
                  <Button variant="ghost" size="icon" aria-label={`Copy ${environment.name}`} title="Copy to a custom Environment" disabled={copying.pending} onClick={() => setForking(environment)}>
                    <Copy className="h-4 w-4" />
                  </Button>
                  {environment.ownerType === "tenant" && (
                    <Button variant="ghost" size="icon" aria-label={`Delete ${environment.name}`} onClick={() => setDeleting(environment)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </div>
              {environment.description && <p className="mt-3 text-sm text-neutral-600">{environment.description}</p>}
              <p className="mt-3 text-xs text-neutral-500">Updated {new Date(environment.updatedAt).toLocaleString()}</p>
            </section>
          ))}
        </div>
      </div>
      <CopyEnvironmentDialog environment={forking} onClose={() => setForking(null)} onConfirm={() => { if (forking) copying.copy(forking); }} />
      <DeleteEnvironmentDialog environment={deleting} onClose={() => setDeleting(null)} />
    </div>
  );
}
