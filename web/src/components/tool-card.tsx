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
}

function formatContent(content: unknown): string {
  if (typeof content === "string") return content;
  return JSON.stringify(content, null, 2) ?? "";
}

function toolPresentation(name: string, input: unknown) {
  const key = name.split(/[.:/]/).pop()?.toLowerCase() ?? name;
  const fields = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const detail = [fields.path, fields.file_path, fields.command, fields.pattern, fields.query, fields.url].find((value) => typeof value === "string") as string | undefined;
  if (/^(read|read_file)$/.test(key)) return { label: "Read file", icon: FileText, detail };
  if (/^(write|write_file|edit|edit_file|apply_patch)$/.test(key)) return { label: "Edit file", icon: Pencil, detail };
  if (/^(grep|glob|search|web_search)$/.test(key)) return { label: "Search", icon: Search, detail };
  if (/^(bash|shell|exec|exec_command)$/.test(key)) return { label: "Run command", icon: Terminal, detail };
  return { label: name, icon: Wrench, detail };
}

export function ToolCard({ name, input, serverName, result, streaming = false, running = false }: ToolCardProps) {
  const { label, icon: Icon, detail } = toolPresentation(name, input);
  const pending = !result && (running || streaming);
  const status = result ? result.isError ? "Failed" : "Completed" : pending ? "Running" : "No result";
  return (
    <SessionDisclosure defaultOpen={result?.isError} className={`session-tool ${result?.isError ? "session-tool-error" : ""}`} summary={<>
      <Icon size={14} />
      <span className="session-tool-label" title={[serverName, name].filter(Boolean).join(" / ")}>{label}</span>
      {detail && <span className="session-tool-detail" title={detail}>{detail}</span>}
      <span className="session-tool-status" aria-label={status} title={status}>
        {result ? result.isError ? <XCircle size={13} /> : <Check size={13} /> : <Circle size={11} className={pending ? "animate-pulse" : ""} />}
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
