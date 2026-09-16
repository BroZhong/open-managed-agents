import { Wrench, FileText, Pencil, Search, Terminal, Check, Circle, XCircle } from "lucide-react";
import { SessionDisclosure } from "@/components/session-disclosure";

interface ToolResult { content: unknown; isError: boolean }
interface ToolCardProps {
  name: string;
  toolUseId: string;
  input: unknown;
  serverName?: string;
  result?: ToolResult;
  streaming?: boolean;
  running?: boolean;
  onActivate?: () => void;
  detail?: string;
  status?: string;
  title?: string;
}

function formatContent(content: unknown): string {
  if (typeof content === "string") return content;
  return JSON.stringify(content, null, 2) ?? "";
}

function toolPresentation(name: string, input: unknown) {
  const key = name.split(/[.:/]/).pop()?.toLowerCase() ?? name;
  const fields = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const detail = [fields.path, fields.file_path, fields.command, fields.pattern, fields.query, fields.url].find((value) => typeof value === "string") as string | undefined;
  if (key === "agent") return { label: "Agent", icon: Wrench, detail: String(fields.description || fields.prompt || fields.task || "Delegated task") };
  if (/^(read|read_file)$/.test(key)) return { label: "Read file", icon: FileText, detail };
  if (/^(write|write_file|edit|edit_file|apply_patch)$/.test(key)) return { label: "Edit file", icon: Pencil, detail };
  if (/^(grep|glob|search|web_search)$/.test(key)) return { label: "Search", icon: Search, detail };
  if (/^(bash|shell|exec|exec_command)$/.test(key)) return { label: "Run command", icon: Terminal, detail };
  return { label: name, icon: Wrench, detail };
}

export function ToolCard({ name, toolUseId, input, serverName, result, streaming = false, running = false, onActivate, detail: detailOverride, status: statusOverride, title }: ToolCardProps) {
  const { label, icon: Icon, detail: inputDetail } = toolPresentation(name, input);
  const detail = detailOverride ?? inputDetail;
  const pending = !result && (running || streaming);
  const status = statusOverride ?? (result ? result.isError ? "Failed" : "Completed" : pending ? "Running" : "No result");
  const failed = result?.isError || /failed|interrupted|recovery_required|budget_exhausted/.test(status);
  const completed = status.toLowerCase() === "completed";
  return (
    <SessionDisclosure id={`tool-${toolUseId}`} title={title} onActivate={onActivate} defaultOpen={result?.isError} className={`session-tool ${failed ? "session-tool-error" : ""}`} summary={<>
      <Icon size={14} />
      <span className="session-tool-label" title={[serverName, name].filter(Boolean).join(" / ")}>{label}</span>
      {detail && <span className="session-tool-detail" title={detail}>{detail}</span>}
      <span className="session-tool-status" aria-label={status} title={status}>
        {failed ? <XCircle size={13} /> : completed ? <Check size={13} /> : <Circle size={11} className={pending || /running|queued|waiting/.test(status) ? "animate-pulse" : ""} />}
      </span>
    </>}>
      <div className="session-tool-payload">
        <p>{[serverName, name].filter(Boolean).join(" / ")} · {status}</p>
        <h4>Input</h4>
        <pre>{formatContent(input)}</pre>
        {result && <><h4>Result</h4><pre>{formatContent(result.content)}</pre></>}
      </div>
    </SessionDisclosure>
  );
}
