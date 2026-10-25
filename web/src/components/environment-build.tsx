import { useEffect, useRef } from "react";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  buildFinished,
  useEnvironmentBuildLog,
  useRebuildEnvironment,
  type Environment,
  type EnvironmentBuildSummary,
} from "@/lib/hooks/use-environments";

const BUILD_STATUS: Record<EnvironmentBuildSummary["status"], { label: string; className: string }> = {
  pending: { label: "排队中", className: "bg-amber-50 text-amber-700" },
  running: { label: "构建中", className: "bg-blue-50 text-blue-700" },
  succeeded: { label: "成功", className: "bg-green-50 text-green-700" },
  failed: { label: "失败", className: "bg-red-50 text-red-700" },
  superseded: { label: "已被新的修改取代", className: "bg-neutral-100 text-neutral-600" },
};

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
    <section className="space-y-3" aria-label="构建">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold">构建</h2>
        {status && (
          <span className={cn("rounded-md px-2 py-0.5 text-xs font-medium", BUILD_STATUS[status.status].className)}>
            {BUILD_STATUS[status.status].label}
          </span>
        )}
        {environment.ownerType === "tenant" && (
          <Button
            variant="outline"
            className="ml-auto"
            disabled={rebuild.isPending}
            onClick={() => rebuild.mutate(undefined, {
              onSuccess: () => toast.success("已开始重新构建"),
              onError: (failure) => toast.error(failure.message),
            })}
          >
            <RefreshCw className="h-4 w-4" />重新构建
          </Button>
        )}
      </div>
      {!status ? <p className="text-sm text-neutral-500">还没有构建。</p> : (
        <>
          <p className="text-xs text-neutral-500">
            {status.id} · 创建 {time(status.createdAt)} · 开始 {time(status.startedAt)} · 结束 {time(status.finishedAt)}
          </p>
          {status.errorMessage && <p role="alert" className="text-sm text-red-600">{status.errorMessage}</p>}
          {log.error && <p role="alert" className="text-sm text-red-600">构建日志读取失败：{log.error.message}</p>}
          {log.data?.truncated && <p className="text-xs text-neutral-500">日志只保留最后 1 MiB，更早的输出已省略。</p>}
          <pre
            ref={view}
            aria-label="构建日志"
            className="max-h-[480px] min-h-24 overflow-auto whitespace-pre-wrap break-all rounded-xl bg-neutral-950 p-4 font-mono text-xs text-neutral-100"
          >
            {text || (running ? "等待构建输出…" : "没有日志。")}
          </pre>
          {running && <p className="text-xs text-neutral-500">每 2 秒刷新，直到构建结束。</p>}
        </>
      )}
    </section>
  );
}
