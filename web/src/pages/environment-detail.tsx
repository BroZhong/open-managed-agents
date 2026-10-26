import { useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ArrowLeft, Copy, Pencil, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { EnvironmentForm, type EnvironmentFormSection } from "@/components/environment-form";
import { BuiltInTag, EnvironmentStatusBadge } from "@/components/environment-badges";
import { EnvironmentBuildPanel } from "@/components/environment-build";
import { EnvironmentManifest } from "@/components/environment-manifest";
import { CopyEnvironmentDialog, DeleteEnvironmentDialog } from "@/components/environment-actions";
import {
  useCopyEnvironment,
  useEnvironment,
  useUpdateEnvironment,
  type Environment,
} from "@/lib/hooks/use-environments";

export default function EnvironmentDetailPage() {
  const { id = "" } = useParams();
  const { data: environment, isLoading, error } = useEnvironment(id);
  const copying = useCopyEnvironment();
  const navigate = useNavigate();
  const [forking, setForking] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const builtIn = environment?.ownerType === "platform";
  return (
    <div>
      <PageHeader title={environment?.name ?? "Environment"}>
        <Link to="/environments" className="inline-flex items-center gap-2 text-sm text-neutral-500"><ArrowLeft className="h-4 w-4" />All Environments</Link>
      </PageHeader>
      <div className="space-y-6 p-6">
        {isLoading ? <p role="status">Loading…</p> : error ? <p role="alert" className="text-sm text-red-600">{error.message}</p> : !environment ? null : (
          <div key={environment.id} className="space-y-6">
            <div className="flex flex-wrap items-center gap-2">
              {builtIn && <BuiltInTag />}
              <EnvironmentStatusBadge status={environment.status} />
              <div className="ml-auto flex gap-2">
                <Button variant="outline" disabled={copying.pending} onClick={() => setForking(true)}>
                  <Copy className="h-4 w-4" />Copy to a custom Environment
                </Button>
                {!builtIn && (
                  <Button variant="outline" aria-label="Delete Environment" onClick={() => setDeleting(true)}><Trash2 className="h-4 w-4" /></Button>
                )}
              </div>
            </div>
            {builtIn && <p className="text-xs text-neutral-500">Built-in Environments are read-only; copy one to change it.</p>}
            <EditableSection environment={environment} section="description" title="Description">
              <p className="whitespace-pre-wrap break-words text-sm text-neutral-600">{environment.description || "No description."}</p>
            </EditableSection>
            <EditableSection environment={environment} section="configuration" title="Configuration">
              <Overview environment={environment} />
            </EditableSection>
            <EnvironmentManifest manifest={environment.manifest} />
            <EditableSection environment={environment} section="env" title="Variables">
              <Variables environment={environment} />
            </EditableSection>
            <EditableSection environment={environment} section="initScript" title="Init script">
              {environment.initScript
                ? <pre className="max-h-[480px] overflow-auto rounded-xl bg-neutral-50 p-4 font-mono text-xs">{environment.initScript}</pre>
                : <p className="text-sm text-neutral-500">No init script.</p>}
            </EditableSection>
            <EnvironmentBuildPanel environment={environment} />
          </div>
        )}
      </div>
      <CopyEnvironmentDialog environment={forking && environment ? environment : null} onClose={() => setForking(false)}
        onConfirm={() => { if (environment) copying.copy(environment); }} />
      <DeleteEnvironmentDialog environment={deleting && environment ? environment : null} onClose={() => setDeleting(false)}
        onDeleted={() => navigate("/environments")} />
    </div>
  );
}

function EditableSection({ environment, section, title, children }: {
  environment: Environment;
  section: EnvironmentFormSection;
  title: string;
  children: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const update = useUpdateEnvironment(environment.id);
  return (
    <section aria-label={title} className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {environment.ownerType === "tenant" && !editing && (
          <Button variant="ghost" size="sm" aria-label={`Edit ${title}`} onClick={() => { update.reset(); setEditing(true); }}>
            <Pencil className="h-3.5 w-3.5" />Edit
          </Button>
        )}
      </div>
      {editing ? (
        <EnvironmentForm
          environment={environment}
          section={section}
          pending={update.isPending}
          error={update.error}
          submitLabel={section === "initScript" ? "Save & rebuild" : "Save"}
          onCancel={() => setEditing(false)}
          onSubmit={(input) => update.mutate(input, { onSuccess: () => setEditing(false) })}
        />
      ) : children}
    </section>
  );
}

function Overview({ environment }: { environment: Environment }) {
  return (
    <dl className="grid gap-x-6 gap-y-3 rounded-2xl border border-neutral-200 p-5 text-sm md:grid-cols-[10rem_1fr]">
      <dt className="text-neutral-500">Base Image</dt>
      <dd>{environment.baseImage}</dd>
      <dt className="text-neutral-500">Image</dt>
      <dd className="break-all font-mono text-xs">
        {environment.image ?? "Not built yet"}
        {environment.image && environment.status !== "ready" && <p className="mt-1 font-sans text-neutral-500">New Sandboxes keep using this image until a new build succeeds.</p>}
      </dd>
    </dl>
  );
}

/** Secret values never reach the console: only their names. */
function Variables({ environment }: { environment: Environment }) {
  return (
    <>
      {environment.env.length === 0 ? <p className="text-sm text-neutral-500">No variables.</p> : (
        <table className="w-full text-left text-sm">
          <tbody>
            {environment.env.map((variable) => (
              <tr key={variable.name} className="border-b border-neutral-100 last:border-0">
                <td className="py-2 pr-4 font-mono text-xs">{variable.name}</td>
                <td className="break-all py-2 font-mono text-xs text-neutral-600">
                  {!("secretRef" in variable) ? variable.value : variable.secretRef.source === "platform" ? "Provided by platform ••••" : "Secret ••••"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
