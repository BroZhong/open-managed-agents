import type { Command, Result, Values } from "./types.js";
function cell(v: unknown): string {
  return v === undefined
    ? ""
    : typeof v === "object"
      ? JSON.stringify(v)
      : String(v);
}
export function render(
  command: Command,
  result: Result,
  flags: Values,
): string {
  if (result.silent) return "";
  if (flags.raw)
    return result.raw ?? String((result.data as Values)?.content ?? "");
  if (flags.field) {
    const rows = Array.isArray(result.data) ? result.data : [result.data];
    return rows
      .flatMap((row) => {
        let v = row;
        for (const k of flags.field.split(".")) {
          if (v === null || typeof v !== "object" || !Object.hasOwn(v, k))
            return [];
          v = v[k];
        }
        return [cell(v) + "\n"];
      })
      .join("");
  }
  const envelope = {
    ok: result.ok ?? true,
    command: command.path,
    data: result.data,
    meta: result.meta ?? {},
  };
  const format = flags["dry-run"]
    ? "json"
    : (flags.format ?? (process.stdout.isTTY ? "table" : "json"));
  if (format === "json") return JSON.stringify(envelope) + "\n";
  if (format === "ndjson")
    return (Array.isArray(result.data) ? result.data : [result.data])
      .map((x) => JSON.stringify(x) + "\n")
      .join("");
  const data = result.data;
  let columns: string[], rows: Values[];
  if (Array.isArray(data) && data.some((x) => x && typeof x === "object")) {
    columns =
      command.path === "agent list"
        ? ["id", "name", "description", "runtime", "model"]
        : command.path === "session list"
          ? [
              "id",
              "title",
              "agentId",
              "workspaceId",
              "status",
              "createdAt",
              "updatedAt",
            ]
          : command.path === "guide list"
            ? ["name", "title", "description"]
            : command.path === "doctor"
              ? ["name", "status", "message", "hint"]
              : ["id", "name", "status", "path", "size", "updatedAt", "updated_at"];
    rows = data;
  } else if (data && typeof data === "object" && !Array.isArray(data)) {
    columns = ["key", "value"];
    rows = Object.keys(data)
      .sort()
      .map((k) => ({ key: k, value: (data as Values)[k] }));
  } else {
    columns = ["value"];
    rows = (Array.isArray(data) ? data : [data]).map((value) => ({ value }));
  }
  const escape = (s: string) =>
    /[",\r\n]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s;
  return (
    [columns, ...rows.map((r) => columns.map((k) => cell(r[k])))]
      .map((row) =>
        row
          .map((s) =>
            format === "csv"
              ? escape(s)
              : s
                  .replaceAll("\n", "\\n")
                  .replaceAll("\r", "\\r")
                  .replaceAll("\t", "\\t"),
          )
          .join(format === "csv" ? "," : "\t"),
      )
      .join("\n") + "\n"
  );
}
