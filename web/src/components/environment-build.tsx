import { useEffect, useRef } from "react";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { BuildStatusBadge } from "@/components/environment-badges";
import {
  buildFinished,
  useEnvironmentBuildLog,
  useRebuildEnvironment,
  type Environment,
} from "@/lib/hooks/use-environments";

const time = (value: string | null) => (value ? new Date(value).toLocaleString() : "—");

/**
 * The Environment's latest build: its status and error, its log refreshed
 * every 2 s until it ends, and for the Tenant's own Environments a rebuild.
 */
export function EnvironmentBuildPanel({ environment }: { environment: Environment }) {
  const build = environment.lastBuild;
  const log = useEnvironmentBuildLog(environment.id, build?.id);
  const rebuild = useRebuildEnvironment(environment.id);
  const view = useRef<HTMLPreElement>(null);
  const text = log.data?.text ?? "";
  // Follow the end of the log as it grows.
  useEffect(() => {
    if (view.current) view.current.scrollTop = view.current.scrollHeight;
  }, [text]);
  // The log's status is read with each page, so it can be newer than the Environment's.
  const status = log.data && log.data.build.id === build?.id ? log.data.build : build;
  const running = status ? !buildFinished(status.status) : false;
  return (
    <section className="space-y-3" aria-label="Build">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold">Build</h2>
        {status && <BuildStatusBadge status={status.status} />}
        {environment.ownerType === "tenant" && (
          <Button
            variant="outline"
            className="ml-auto"
            disabled={rebuild.isPending}
            onClick={() => rebuild.mutate(undefined, {
              onSuccess: () => toast.success("Rebuild started"),
              onError: (failure) => toast.error(failure.message),
            })}
          >
            <RefreshCw className="h-4 w-4" />Rebuild
          </Button>
        )}
      </div>
      {!status ? <p className="text-sm text-neutral-500">No build yet.</p> : (
        <>
          <p className="text-xs text-neutral-500">
            {status.id} · created {time(status.createdAt)} · started {time(status.startedAt)} · finished {time(status.finishedAt)}
          </p>
          {status.errorMessage && <p role="alert" className="text-sm text-red-600">{status.errorMessage}</p>}
          {log.error && <p role="alert" className="text-sm text-red-600">The build log could not be read: {log.error.message}</p>}
          {log.data?.truncated && <p className="text-xs text-neutral-500">Only the last 1 MiB of the log is kept; earlier output is omitted.</p>}
          <pre
            ref={view}
            aria-label="Build log"
            className="max-h-[480px] min-h-24 overflow-auto whitespace-pre-wrap break-all rounded-xl bg-neutral-950 p-4 font-mono text-xs text-neutral-100"
          >
            {text || (running ? "Waiting for build output…" : "No log.")}
          </pre>
          {running && <p className="text-xs text-neutral-500">Refreshed every 2 s until the build ends.</p>}
        </>
      )}
    </section>
  );
}
