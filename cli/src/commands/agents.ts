import { id, pagination, type Command } from "../types.js";
import { pick } from "../http.js";
export const agents: Command[] = [
  {
    path: "agent list",
    description: "List Agent configurations (summary only)",
    flags: pagination,
    api: ["GET /v1/agents"],
    run: (c) =>
      c.http.pages("/v1/agents", c.flags, (x) =>
        pick(x, ["id", "name", "description", "runtime", "model"]),
      ),
  },
  {
    path: "agent get",
    description: "Read a saved Agent configuration, not runtime tool discovery",
    flags: id("agent"),
    api: ["GET /v1/agents/{id}"],
    run: async (c) => ({
      data: await c.http.request(
        "/v1/agents/" + encodeURIComponent(c.flags["agent-id"]),
      ),
    }),
  },
];

import { string, boolean, type Flag } from "../types.js";
import { invalid } from "../errors.js";
import { base, write } from "./common.js";
const config: Record<string, Flag> = {
  name: string("Agent name"),
  description: string("Description"),
  runtime: string("Runtime", {
    enum: ["claude-code", "codex", "pi-agent", "mock"],
  }),
  model: string("Deployment model"),
  system: string("Complete system instructions"),
};
const configFlags = Object.fromEntries(
  Object.entries(config).map(([k, v]) => [k, { ...v, field: k }]),
);
for (const action of ["create", "update"] as const)
  agents.push({
    path: `agent ${action}`,
    description: `${action} Agent configuration. Existing Sessions retain their snapshots.`,
    flags: {
      ...(action === "update" ? id("agent") : {}),
      ...configFlags,
      "system-file": string("UTF-8 instructions file or -", {
        field: "system",
        source: "text-file",
      }),
    },
    bodyFields: config,
    requiredBody:
      action === "create" ? ["name", "runtime", "model", "system"] : [],
    exclusive: [["system", "system-file"]],
    write: true,
    effects: "Changes Agent configuration only; no historical Session updates.",
    api: [`POST /v1/agents${action === "update" ? "/{id}" : ""}`],
    validate: (_f, b) => {
      if (!Object.keys(b).length) invalid("Provide at least one update field");
      for (const k of ["name", "model", "system"])
        if (k in b && !b[k]) invalid(`${k} cannot be empty`, k);
    },
    run: (c) =>
      write(c, {
        method: "POST",
        path: action === "create" ? "/v1/agents" : base(c, "agent"),
        body: c.body,
      }),
  });
agents.push({
  path: "agent fork",
  description:
    "Copy configuration, Agent Files and private Skill contents; no Sessions, Loops or Workspaces",
  flags: { ...id("agent"), name: string("New Agent name", { field: "name" }) },
  bodyFields: { name: config.name! },
  requiredBody: ["name"],
  write: true,
  validate: (_f, b) => {
    if (!b.name) invalid("Name cannot be empty", "--name");
  },
  api: ["POST /v1/agents/{id}/fork"],
  run: (c) =>
    write(c, {
      method: "POST",
      path: base(c, "agent") + "/fork",
      body: c.body,
    }),
});
agents.push({
  path: "agent delete",
  description:
    "Delete the Agent record; no cascade or execution termination guarantee",
  flags: id("agent"),
  write: true,
  confirm: true,
  api: ["DELETE /v1/agents/{id}"],
  run: (c) => write(c, { method: "DELETE", path: base(c, "agent") }),
});
const fileName = string("Agent File name (without .md)", {
  required: true,
  enum: ["IDENTITY", "SOUL", "USER", "MEMORY"],
});
const content = string("Complete UTF-8 text");
export const textFlags = {
  content: { ...content, field: "content" },
  file: string("UTF-8 file or - for stdin", {
    field: "content",
    source: "text-file",
  }),
};
agents.push({
  path: "agent file list",
  description: "List shared Agent File metadata",
  flags: id("agent"),
  api: ["GET /v1/agents/{id}/files"],
  run: async (c) => {
    const r = await c.http.request(base(c, "agent") + "/files");
    return { data: r.data, meta: { has_more: false } };
  },
});
for (const action of ["read", "write", "delete"] as const)
  agents.push({
    path: `agent file ${action}`,
    description: `${action} an Agent File shared by all its Sessions; write replaces all text`,
    flags: {
      ...id("agent"),
      name: fileName,
      ...(action === "read"
        ? { raw: boolean("Exact text bytes, no added newline") }
        : {}),
      ...(action === "write" ? textFlags : {}),
    },
    ...(action === "write"
      ? {
          bodyFields: { content },
          requiredBody: ["content"],
          exclusive: [["content", "file"]],
        }
      : {}),
    write: action !== "read",
    confirm: action === "delete",
    api: [
      `${action === "read" ? "GET" : action === "write" ? "POST" : "DELETE"} /v1/agents/{id}/files/{filename}`,
    ],
    run: async (c) => {
      const path = base(c, "agent") + "/files/" + c.flags.name;
      if (action === "read") return { data: await c.http.request(path) };
      return write(
        c,
        {
          method: action === "write" ? "POST" : "DELETE",
          path,
          ...(action === "write" ? { body: c.body } : {}),
        },
        action === "write"
          ? (x) => pick(x, ["filename", "updatedAt"])
          : undefined,
      );
    },
  });
