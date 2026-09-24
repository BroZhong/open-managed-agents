import {
  boolean,
  id,
  string,
  type Command,
  type Context,
  type Values,
  type Flag,
} from "../types.js";
import { CliError, invalid } from "../errors.js";
import { remotePath, utf8, workspaceId } from "../input.js";
import { pick } from "../http.js";
import { base, enc, noTarget, plan, write } from "./common.js";
import { textFlags } from "./agents.js";
export const descriptorPath = (
  root: string,
  path: string,
  query = "expiresIn=600",
) =>
  root +
  "/files/" +
  path.split("/").map(enc).join("/") +
  (query ? "?" + query : "");
export async function workspaceFiles(
  c: Context,
  prefix?: string,
  verified = false,
): Promise<Values[]> {
  if (!verified) await c.http.request(base(c, "workspace"));
  const r = await c.http.request(
    base(c, "workspace") + "/files" + (prefix ? "?prefix=" + enc(prefix) : ""),
  );
  if (!Array.isArray(r.data)) throw new Error("Invalid file list response");
  return r.data
    .filter(
      (f: Values) =>
        !f.path.endsWith("/") &&
        !f.path.startsWith(".oma-workspace-checks/") &&
        (!prefix || f.path.startsWith(prefix + "/")),
    )
    .map((f: Values) => pick(f, ["path", "size", "updated_at"]));
}
const wsFields = ["id", "tenantId", "name", "createdAt"];
export const files: Command[] = [
  {
    path: "workspace list",
    description: "List all visible Workspaces in server order",
    flags: {},
    api: ["GET /v1/workspaces"],
    run: async (c) => ({
      data: (await c.http.request("/v1/workspaces")).data.map((x: Values) =>
        pick(x, wsFields),
      ),
    }),
  },
  {
    path: "workspace get",
    description:
      "Read Workspace metadata and complete file paths (two requests, not an atomic snapshot)",
    flags: id("workspace"),
    api: ["GET /v1/workspaces/{id}", "GET /v1/workspaces/{id}/files"],
    run: async (c) => ({
      data: {
        ...pick(await c.http.request(base(c, "workspace")), wsFields),
        files: (await workspaceFiles(c, undefined, true)).map((f) => f.path),
      },
    }),
  },
  {
    path: "workspace file list",
    description:
      "List all files, including hidden and empty files; prefix matches directory boundaries",
    flags: { ...id("workspace"), prefix: string("Directory prefix") },
    api: ["GET /v1/workspaces/{id}/files"],
    validate: (f) => {
      if (f.prefix !== undefined) f.prefix = remotePath(f.prefix, false, true);
    },
    run: async (c) => ({ data: await workspaceFiles(c, c.flags.prefix) }),
  },
];
for (const action of ["create", "rename"] as const)
  files.push({
    path: `workspace ${action}`,
    description: `${action} Workspace display metadata; names are preserved, including empty strings`,
    flags: {
      ...(action === "rename"
        ? id("workspace")
        : { "workspace-id": string("Optional custom ID", { field: "id" }) }),
      name: string("Display name", { field: "name" }),
    },
    bodyFields: {
      ...(action === "create" ? { id: string("Custom ID") } : {}),
      name: string("Display name"),
    },
    requiredBody: action === "rename" ? ["name"] : [],
    write: true,
    api: [`POST /v1/workspaces${action === "rename" ? "/{id}" : ""}`],
    validate: (_f, b) => {
      if (b.id !== undefined) workspaceId(b.id);
    },
    run: (c) =>
      write(
        c,
        {
          method: "POST",
          path: action === "create" ? "/v1/workspaces" : base(c, "workspace"),
          body: c.body,
        },
        (x) => pick(x, wsFields),
      ),
  });
files.push({
  path: "workspace delete",
  description:
    "Soft-delete Workspace; hides related Sessions but retains files, history, queues and running execution. No recovery API.",
  flags: id("workspace"),
  write: true,
  confirm: true,
  api: ["DELETE /v1/workspaces/{id}"],
  run: (c) => write(c, { method: "DELETE", path: base(c, "workspace") }),
});
for (const noun of ["workspace", "skill"] as const) {
  const skill = noun === "skill";
  const pathFlag = string("Relative file path", { required: true });
  for (const action of ["read", "write", "rename", "delete"] as const) {
    const bodyFields: Record<string, Flag> | undefined =
      action === "write"
        ? {
            path: string("Relative file path"),
            content: string("Complete UTF-8 content"),
          }
        : action === "rename"
          ? { from: string("Source path"), to: string("Destination path") }
          : undefined;
    files.push({
      path: `${noun} file ${action}`,
      description: `${action} a ${noun} text file. ${skill ? "Text channel may normalize BOM/invalid UTF-8 on the server. Root SKILL.md may only be written." : "Writes replace contents without a Session lock."} ${action === "rename" ? "Copy then delete is non-atomic; preflight cannot prevent concurrent overwrites." : action === "delete" ? "No file recovery API." : ""}`,
      flags: {
        ...id(noun),
        path:
          action === "write" || action === "rename"
            ? string("Relative path", {
                field: action === "rename" ? "from" : "path",
              })
            : pathFlag,
        ...(action === "write" ? textFlags : {}),
        ...(action === "read"
          ? { raw: boolean("Exact content without envelope or newline") }
          : {}),
        ...(action === "rename"
          ? {
              to: string("Destination path", { field: "to" }),
              overwrite: boolean(
                "Permit replacing destination; not an atomic condition",
              ),
            }
          : {}),
      },
      bodyFields,
      requiredBody:
        action === "write"
          ? ["path", "content"]
          : action === "rename"
            ? ["from", "to"]
            : [],
      exclusive: action === "write" ? [["content", "file"]] : [],
      write: action !== "read",
      confirm: action === "delete",
      api: [
        `${action === "read" ? "GET" : action === "write" ? "PUT" : action === "rename" ? "POST" : "DELETE"} /v1/${noun}s/{id}/files/${action === "rename" ? "rename" : !skill && action === "read" ? "{path}" : "content"}`,
      ],
      validate: (f, b) => {
        for (const k of action === "rename"
          ? ["from", "to"]
          : action === "write"
            ? ["path"]
            : [])
          b[k] = remotePath(b[k], skill);
        if (action === "read" || action === "delete")
          f.path = remotePath(f.path, skill);
        if (
          skill &&
          ((action === "rename" &&
            (b.from === "SKILL.md" || b.to === "SKILL.md")) ||
            (action === "delete" && f.path === "SKILL.md"))
        )
          invalid(
            "Root SKILL.md is protected. Use file write to edit, skill delete for a Library or agent skill unequip for a fork.",
            "--path",
            "protected_skill_entry",
          );
      },
      run: async (c) => {
        const root = base(c, noun);
        if (!skill) await c.http.request(root);
        const read = (p: string) =>
          c.http.request(
            skill
              ? root + "/files/content?path=" + enc(p)
              : descriptorPath(root, p),
          );
        if (action === "read") {
          const r = await read(c.flags.path);
          if (skill) return { data: r };
          const bytes = await c.http.request(r.url, "GET", undefined, {
            signed: true,
            bytes: true,
          });
          if (
            /^(image|audio|video)\//.test(r.contentType ?? "") ||
            /application\/(pdf|zip|octet-stream)/.test(r.contentType ?? "")
          )
            invalid("Binary file: use workspace file download", "--path");
          return {
            data: { path: c.flags.path, content: utf8(bytes, "--path") },
          };
        }
        if (action === "write")
          return write(
            c,
            { method: "PUT", path: root + "/files/content", body: c.body },
            () => ({ path: c.body.path }),
          );
        if (action === "delete")
          return write(c, {
            method: "DELETE",
            path: root + "/files/content?path=" + enc(c.flags.path),
          });
        await read(c.body.from);
        if (c.body.from === c.body.to) {
          const data = {
            type: `${noun}_file_renamed`,
            ...(skill ? { id: c.flags["skill-id"] } : {}),
            ...c.body,
          };
          return c.flags["dry-run"] ? plan(c, []) : { data };
        }
        await noTarget(() => read(c.body.to), c.flags.overwrite);
        return write(c, {
          method: "POST",
          path: root + "/files/rename",
          body: c.body,
        });
      },
    });
  }
}
files.push({
  path: "workspace file url",
  description:
    "Return a temporary read credential, not a stable resource ID; download controls attachment only. MIME may differ from stored headers.",
  flags: {
    ...id("workspace"),
    path: string("Relative file path", { required: true }),
    "expires-in": {
      type: "integer",
      description: "URL lifetime in seconds",
      default: 600,
      min: 60,
      max: 900,
    },
    download: boolean("Sign an attachment URL; does not download"),
  },
  api: ["GET /v1/workspaces/{id}/files/{path}"],
  validate: (f) => {
    f.path = remotePath(f.path);
  },
  run: async (c) => {
    await c.http.request(base(c, "workspace"));
    return {
      data: await c.http.request(
        descriptorPath(
          base(c, "workspace"),
          c.flags.path,
          `expiresIn=${c.flags["expires-in"]}${c.flags.download ? "&download=1" : ""}`,
        ),
      ),
    };
  },
});

// Metadata includes the read-only guards used by these executable handlers.
for (const command of files) {
  if (command.path.startsWith("workspace file "))
    command.api = [
      ...new Set(["GET /v1/workspaces/{id}", ...(command.api ?? [])]),
    ];
  if (command.path.endsWith("file rename"))
    command.api = [
      ...new Set([
        ...(command.api ?? []),
        command.path.startsWith("skill")
          ? "GET /v1/skills/{id}/files/content"
          : "GET /v1/workspaces/{id}/files/{path}",
      ]),
    ];
}
