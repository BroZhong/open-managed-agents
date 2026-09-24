import {
  boolean,
  id,
  pagination,
  string,
  type Command,
  type Flag,
  type Values,
} from "../types.js";
import { invalid, normalizeError, CliError } from "../errors.js";
import { workspaceId } from "../input.js";
import { pick } from "../http.js";
import { base, write, plan } from "./common.js";
import { history, follow, streamFormat, waitSession } from "../events.js";
const waitFlags: Record<string, Flag> = {
  stream: boolean("Complete Event NDJSON, followed by one result"),
  "wait-timeout": {
    type: "duration",
    description: "Total local wait (0 unlimited), not an HTTP timeout",
    default: "2h",
  },
};
export const sessions: Command[] = [
  {
    path: "session list",
    description:
      "List visible Sessions; includes Loop and Child Sessions by default",
    flags: {
      ...pagination,
      "agent-id": string("Filter Agent ID"),
      status: string("Session status", {
        enum: ["idle", "waiting", "running", "terminated"],
      }),
      "exclude-loop": boolean("Exclude Loop Sessions"),
      "exclude-delegated": boolean("Exclude Child Sessions"),
    },
    api: ["GET /v1/sessions"],
    run: (c) =>
      c.http.pages(
        "/v1/sessions",
        {
          ...c.flags,
          query: {
            agent_id: c.flags["agent-id"],
            status: c.flags.status,
            exclude_loop: c.flags["exclude-loop"] ? true : undefined,
            exclude_delegated: c.flags["exclude-delegated"] ? true : undefined,
          },
        },
        (x) =>
          pick(x, [
            "id",
            "title",
            "agentId",
            "workspaceId",
            "status",
            "createdAt",
            "updatedAt",
          ]),
      ),
  },
  {
    path: "session get",
    description:
      "Read Session metadata and saved Agent snapshot, without history or Workspace files",
    flags: id("session"),
    api: ["GET /v1/sessions/{id}"],
    run: async (c) => ({ data: await c.http.request(base(c, "session")) }),
  },
  {
    path: "session create",
    description:
      "Create Session; bind an existing or new Workspace. workspace-name only names newly created Workspaces.",
    flags: {
      "agent-id": string("Agent ID", { field: "agent" }),
      "workspace-id": string("Workspace ID", { field: "workspace_id" }),
      "workspace-name": string("New Workspace name", {
        field: "workspace_name",
      }),
    },
    bodyFields: {
      agent: string("Agent ID"),
      workspace_id: string("Workspace ID"),
      workspace_name: string("Workspace name"),
    },
    requiredBody: ["agent"],
    write: true,
    api: ["POST /v1/sessions"],
    validate: (_f, b) => {
      if (!b.agent) invalid("Agent ID cannot be empty", "--agent-id");
      if (b.workspace_id !== undefined) workspaceId(b.workspace_id);
    },
    run: (c) =>
      write(c, { method: "POST", path: "/v1/sessions", body: c.body }),
  },
  {
    path: "session rename",
    description: "Change Session title (trimmed, 1–500 characters)",
    flags: {
      ...id("session"),
      title: string("Display title", { field: "title" }),
    },
    bodyFields: { title: string("Display title") },
    requiredBody: ["title"],
    write: true,
    api: ["POST /v1/sessions/{id}"],
    validate: (_f, b) => {
      b.title = b.title.trim();
      if (!b.title || b.title.length > 500)
        invalid("Title must have 1–500 characters", "--title");
    },
    run: (c) =>
      write(
        c,
        { method: "POST", path: base(c, "session"), body: c.body },
        (x) => pick(x, ["id", "title", "updatedAt"]),
      ),
  },
  {
    path: "session delete",
    description:
      "Hide Session, retain history/files/queue and current Turn. No recovery API; this does not terminate execution.",
    flags: id("session"),
    bodyFields: { deleted: boolean("Must be true") },
    write: true,
    confirm: true,
    api: ["POST /v1/sessions/{id}"],
    validate: (_f, b) => {
      if ("deleted" in b && b.deleted !== true)
        invalid("deleted must be true", "--body");
    },
    run: (c) =>
      write(c, {
        method: "POST",
        path: base(c, "session"),
        body: { deleted: true },
      }),
  },
  {
    path: "session pending",
    description:
      "Preview up to 20 unclaimed Queued Inputs; count is preview count, not queue depth. Empty does not prove idle.",
    flags: id("session"),
    api: ["GET /v1/sessions/{id}/pending"],
    run: async (c) => {
      const r = await c.http.request(base(c, "session") + "/pending");
      return { data: r.data, meta: pick(r, ["count", "has_more"]) };
    },
  },
  {
    path: "session interrupt",
    description:
      "Request stopping only the current Turn; keep output and queued inputs. requested is not proof of stopped execution.",
    flags: id("session"),
    write: true,
    api: ["POST /v1/sessions/{id}/events"],
    run: (c) =>
      write(
        c,
        {
          method: "POST",
          path: base(c, "session") + "/events",
          body: { events: [{ type: "user.interrupt", data: {} }] },
        },
        (x) => ({ sessionId: c.flags["session-id"], requested: x.requested }),
      ),
  },
  {
    path: "session send",
    description:
      "Submit one user.message once; default is asynchronous acceptance, not completion. Wait does not certify business success.",
    flags: {
      ...id("session"),
      prompt: string("Message text", { field: "prompt" }),
      "prompt-file": string("UTF-8 text file or -", {
        field: "prompt",
        source: "text-file",
      }),
      wait: boolean("Wait for all accepted input to drain"),
      ...Object.fromEntries(
        Object.entries(waitFlags).map(([k, v]) => [
          k,
          { ...v, requires: ["wait"] },
        ]),
      ),
    },
    bodyFields: {
      events: {
        type: "json",
        description:
          "Exactly one user.message with data.content text blocks (or data.text)",
      },
    },
    exclusive: [["prompt", "prompt-file", "body"]],
    write: true,
    api: ["POST /v1/sessions/{id}/events"],
    validate: (f, b) => {
      if (
        (f.stream || Object.hasOwn(f, "wait-timeout")) &&
        !f.wait &&
        f["wait-timeout"] !== "2h"
      )
        invalid("--stream/--wait-timeout require --wait");
      if (f.stream && !f.wait) invalid("--stream requires --wait");
      if (f.stream) streamFormat(f);
      if ("prompt" in b) {
        b.events = [
          {
            type: "user.message",
            data: { content: [{ type: "text", text: b.prompt }] },
          },
        ];
        delete b.prompt;
      }
      if (!Array.isArray(b.events) || b.events.length !== 1)
        invalid(
          "Provide exactly one user.message using prompt, prompt-file or body",
        );
      const e = b.events[0];
      if (
        !e ||
        e.type !== "user.message" ||
        Object.keys(e).some((k) => !["type", "data"].includes(k)) ||
        !e.data ||
        typeof e.data !== "object" ||
        Array.isArray(e.data)
      )
        invalid("Only one user.message is allowed", "--body");
      const d = e.data;
      if (
        Object.keys(d).some((k) => !["content", "text"].includes(k)) ||
        ("content" in d && "text" in d)
      )
        invalid("Invalid user.message data", "--body");
      if ("text" in d) {
        if (typeof d.text !== "string")
          invalid("data.text must be text", "--body");
      } else if (
        !Array.isArray(d.content) ||
        !d.content.length ||
        d.content.some(
          (x: any) =>
            !x ||
            x.type !== "text" ||
            typeof x.text !== "string" ||
            Object.keys(x).some((k) => !["type", "text"].includes(k)),
        )
      )
        invalid("data.content must contain text blocks", "--body");
    },
    run: async (c) => {
      const step = {
        method: "POST",
        path: base(c, "session") + "/events",
        body: c.body,
        effects:
          "Accept one message" +
          (c.flags.wait ? "; then observe all accepted inputs until idle" : ""),
      };
      if (c.flags["dry-run"]) return plan(c, [step]);
      const initial =
        c.flags.wait && c.flags.stream ? (await history(c)).data : undefined;
      const receipt = await c.http.request(step.path, "POST", step.body);
      if (!c.flags.wait) return { data: receipt };
      try {
        return await waitSession(c, initial);
      } catch (e) {
        const error = normalizeError(e);
        throw new CliError(
          {
            ...error.info,
            message: "Input was accepted. " + error.message,
            hint: `Do not resend. Run oma-cli session wait --session-id ${c.flags["session-id"]} or inspect its events.`,
            retryable: false,
          },
          error.code,
        );
      }
    },
  },
  {
    path: "session wait",
    description:
      "Wait for all accepted inputs to drain. Remote execution continues on timeout/SIGINT; success does not certify artifacts.",
    flags: { ...id("session"), ...waitFlags },
    dependencies: ["Host includes PR #179 atomic queue-drain/idle contract"],
    api: ["GET /v1/sessions/{id}", "GET /v1/sessions/{id}/events"],
    validate: (f) => {
      if (f.stream) streamFormat(f);
    },
    run: (c) => waitSession(c),
  },
  {
    path: "session events list",
    description:
      "Read Complete Events, without expanding payloadRef; all follows existing pages only",
    flags: {
      ...id("session"),
      "after-seq": {
        type: "integer",
        description: "Exclusive sequence cursor",
        default: 0,
        min: 0,
      },
      limit: {
        type: "integer",
        description: "Page size (no 100-item cap)",
        default: 50,
        min: 1,
      },
      all: boolean("Read all remaining pages"),
    },
    api: ["GET /v1/sessions/{id}/events"],
    run: (c) => history(c, c.flags["after-seq"], c.flags.limit, c.flags.all),
  },
  {
    path: "session events read",
    description: "Read full data for one durable or derived event sequence",
    flags: {
      ...id("session"),
      seq: {
        type: "integer",
        description: "Positive sequence without leading zeroes",
        required: true,
        min: 1,
      },
    },
    api: ["GET /v1/sessions/{id}/events/{seq}/data"],
    run: async (c) => ({
      data: (
        await c.http.request(base(c, "session") + `/events/${c.flags.seq}/data`)
      ).data,
    }),
  },
  {
    path: "session events follow",
    description:
      "Continuous Complete Event NDJSON; explicit durable frame IDs only. Idle/terminated do not end observation.",
    flags: {
      ...id("session"),
      "after-seq": {
        type: "integer",
        description: "Exclusive Last-Event-ID",
        default: 0,
        min: 0,
      },
      duration: {
        type: "duration",
        description: "Total observation duration; 0 unlimited",
        default: "0",
      },
    },
    api: ["GET /v1/sessions/{id}/events (Accept: text/event-stream)"],
    validate: streamFormat,
    run: follow,
  },
];
