import { setTimeout as sleep } from "node:timers/promises";
import { boolean, id, string, type Command, type Context, type Flag, type Result, type Values } from "../types.js";
import { invalid } from "../errors.js";
import { textInput } from "../input.js";
import { pick } from "../http.js";
import { base, enc, plan, write } from "./common.js";

type Variable = { name: string; value?: string; secretRef?: { source: string; key: string } };

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SUMMARY = ["id", "name", "ownerType", "baseImage", "status", "description", "updatedAt"];

const fields: Record<string, Flag> = {
  name: string("Environment name, unique among the Tenant's Environments"),
  description: string("Description"),
  baseImage: string("Base Image", { enum: ["oma-base", "oma-media"] }),
  initScript: string("Bash init script, run once per build as root in /home/user"),
  env: { type: "json", description: "Complete variable list (EnvironmentVariableInput[]); conflicts with variable flags" },
};
const variableFlags: Record<string, Flag> = {
  env: string("Plain variable NAME=VALUE (repeatable)", { repeat: true }),
  "env-file": string("Dotenv file of plain variables, or - for stdin", { source: "text-file" }),
  secret: string("Tenant secret NAME=VALUE, stored encrypted and never shown (repeatable)", { repeat: true }),
  "secret-file": string("Dotenv file of Tenant secrets, or - for stdin", { source: "text-file" }),
};
const VARIABLE_FLAGS = [...Object.keys(variableFlags), "unset"];

function configFlags(action: "create" | "update"): Record<string, Flag> {
  return {
    ...(action === "update" ? id("environment") : {}),
    ...(action === "create"
      ? { from: string("Copy this Environment (a built-in or your own); other flags change the copy", { field: "from" }) }
      : {}),
    name: { ...fields.name!, field: "name" },
    description: { ...fields.description!, field: "description" },
    "base-image": { ...fields.baseImage!, field: "baseImage" },
    "init-script": string("Init script text, @file or - for stdin", { field: "initScript", source: "text" }),
    ...variableFlags,
    ...(action === "update" ? { unset: string("Remove variable NAME (repeatable)", { repeat: true }) } : {}),
  };
}

/** `NAME=VALUE` from a flag: the value may contain `=` but not be empty. */
function assignment(raw: string, param: string): { name: string; value: string } {
  const at = raw.indexOf("=");
  const name = at < 0 ? raw : raw.slice(0, at);
  if (at < 0 || !NAME.test(name)) invalid("Expected NAME=VALUE with a shell variable name", param);
  if (at === raw.length - 1) invalid(`${name} needs a non-empty value`, param);
  return { name, value: raw.slice(at + 1) };
}

/**
 * Dotenv lines: `NAME=VALUE` or `export NAME=VALUE`, blank lines and `#`
 * comments; one pair of matching outer quotes is removed, nothing is expanded.
 */
export function dotenv(text: string, param: string): { name: string; value: string }[] {
  const pairs: { name: string; value: string }[] = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const pair = assignment(trimmed.replace(/^export\s+/, ""), `${param}:${index + 1}`);
    const quoted = /^(["'])([\s\S]*)\1$/.exec(pair.value.trim());
    const value = quoted ? quoted[2]! : pair.value.trim();
    if (!value) invalid(`${pair.name} needs a non-empty value`, `${param}:${index + 1}`);
    pairs.push({ name: pair.name, value });
  }
  return pairs;
}

/** The variables the flags set, in order; a name may be given once. */
async function assignments(c: Context): Promise<{ plain: Values[]; secrets: Values[]; unset: string[] }> {
  const read = async (flag: string) => (c.flags[flag] === undefined ? [] : dotenv(await textInput(c.flags[flag]), `--${flag}`));
  const plain = [...(c.flags.env ?? []).map((x: string) => assignment(x, "--env")), ...(await read("env-file"))];
  const secrets = [...(c.flags.secret ?? []).map((x: string) => assignment(x, "--secret")), ...(await read("secret-file"))];
  const unset: string[] = c.flags.unset ?? [];
  for (const name of unset) if (!NAME.test(name)) invalid("Expected a shell variable name", "--unset");
  const seen = new Set<string>();
  for (const name of [...plain, ...secrets].map((x) => x.name).concat(unset)) {
    if (seen.has(name)) invalid(`${name} is given more than once`, "--env");
    seen.add(name);
  }
  return { plain, secrets, unset };
}

/**
 * Apply the flags to `current` (the Environment's or copy source's list):
 * existing entries keep their place, secrets travel without values (the Host
 * keeps the stored ones), new names are appended.
 */
function merge(current: Variable[], changes: Awaited<ReturnType<typeof assignments>>): Variable[] {
  const set = new Map<string, Variable>([
    ...changes.plain.map((x): [string, Variable] => [x.name, { name: x.name, value: x.value }]),
    ...changes.secrets.map((x): [string, Variable] => [x.name, { name: x.name, secretRef: { source: "environment", key: x.name }, value: x.value }]),
  ]);
  const result = current
    .filter((x) => !changes.unset.includes(x.name))
    .map((x) => set.get(x.name) ?? (x.secretRef ? { name: x.name, secretRef: x.secretRef } : x));
  for (const [name, variable] of set) if (!current.some((x) => x.name === name)) result.push(variable);
  return result;
}

/** Secret values never reach stdout, even in a dry-run plan. */
function redactSecrets(body: Values): Values {
  if (!Array.isArray(body.env)) return body;
  return { ...body, env: body.env.map((x: Variable) => (x.secretRef && x.value !== undefined ? { ...x, value: "[REDACTED]" } : x)) };
}

async function save(c: Context, action: "create" | "update"): Promise<{ data: unknown; code?: number }> {
  const changes = await assignments(c);
  const changing = changes.plain.length + changes.secrets.length + changes.unset.length > 0;
  if (changing && c.body.env !== undefined) invalid("Duplicate field env: use --body env or variable flags", "--env");
  const body: Values = { ...c.body };
  const steps = [];
  if (changing) {
    // Variables replace the whole set: start from the current (or copied) list.
    const from = action === "update" ? base(c, "environment") : body.from ? "/v1/environments/" + encodeURIComponent(body.from) : undefined;
    const current: Variable[] = from ? (await c.http.request(from)).env : [];
    body.env = merge(current, changes);
    if (from) steps.push({ method: "GET", path: from, effects: "Read the current variables (read-only)" });
  }
  const step = { method: "POST", path: action === "create" ? "/v1/environments" : base(c, "environment"), body };
  if (c.flags["dry-run"]) return plan(c, [...steps, { ...step, body: redactSecrets(body) }]);
  return write(c, step);
}

/** How often `environment logs --follow` polls; the image builder writes the log about as often. */
export const LOG_POLL_MS = 2_000;

type LogPage = { build: Values; finished: boolean; text: string; offset: number; nextOffset: number; truncated: boolean };

/** One read of a build's log; `follow` polls from `nextOffset` until the build ends. */
async function logs(c: Context): Promise<Result> {
  const read = (buildId: string | undefined, offset: number): Promise<LogPage> =>
    c.http.request(`${base(c, "environment")}/log?${buildId ? `build_id=${enc(buildId)}&` : ""}offset=${offset}`);
  let page = await read(c.flags["build-id"], 0);
  if (!c.flags.follow) return { data: page, raw: page.text };
  const emit = (current: LogPage) => {
    if (c.flags.raw) {
      if (current.truncated) process.stderr.write("[oma-cli] The build log keeps its last 1 MiB; earlier output was dropped.\n");
      if (current.text) c.write(current.text);
      return;
    }
    if (current.text || current.truncated) {
      c.write(JSON.stringify({ kind: "log", buildId: current.build.id, offset: current.offset, truncated: current.truncated, text: current.text }) + "\n");
    }
  };
  emit(page);
  // The Host reads the status before the log, so the page that says finished holds the whole log.
  while (!page.finished) {
    await sleep(LOG_POLL_MS, undefined, { signal: c.signal }).catch(() => c.signal.throwIfAborted());
    page = await read(page.build.id, page.nextOffset);
    emit(page);
  }
  const data = { build: page.build, finished: true, nextOffset: page.nextOffset };
  if (!c.flags.raw) c.write(JSON.stringify({ kind: "result", ok: true, command: c.command.path, data, meta: {} }) + "\n");
  return { data: null, silent: true };
}

export const environments: Command[] = [
  {
    path: "environment list",
    description: "List visible Environments: built-ins first, then your own",
    flags: {},
    api: ["GET /v1/environments"],
    run: async (c) => ({
      data: (await c.http.request("/v1/environments")).data.map((x: Values) => pick(x, SUMMARY)),
      meta: { has_more: false },
    }),
  },
  {
    path: "environment get",
    description: "Read an Environment; secrets show their names only",
    flags: id("environment"),
    api: ["GET /v1/environments/{id}"],
    run: async (c) => ({ data: await c.http.request(base(c, "environment")) }),
  },
  ...(["create", "update"] as const).map((action): Command => ({
    path: `environment ${action}`,
    description: action === "create"
      ? "Create an Environment, or copy one with --from; it waits for its first build"
      : "Change an Environment; a new init script or Base Image queues a build, variables apply at once",
    flags: configFlags(action),
    bodyFields: action === "create" ? { from: string("Environment to copy"), ...fields } : fields,
    write: true,
    effects: action === "create"
      ? "Creates a Tenant Environment pending its first build"
      : "Changes the Environment; a changed init script or Base Image queues a build",
    api: action === "create"
      ? ["GET /v1/environments/{id} (with --from and variable flags)", "POST /v1/environments"]
      : ["GET /v1/environments/{id} (with variable flags)", "POST /v1/environments/{id}"],
    examples: action === "create"
      ? [
          "oma-cli environment create --name data --base-image oma-base --init-script @init.sh --env PIP_NO_CACHE_DIR=1",
          "oma-cli environment create --from env_video_production --name video --secret MY_API_KEY=…",
        ]
      : ["oma-cli environment update --environment-id example-id --env FOO=bar --unset OLD --init-script @init.sh"],
    validate: (f, b) => {
      const variables = VARIABLE_FLAGS.some((k) => f[k] !== undefined);
      if (action === "create" && !b.from) {
        if (!b.name) invalid("Missing required field name (or copy with --from)", "--name");
        if (!b.baseImage) invalid("Missing required field baseImage (or copy with --from)", "--base-image");
      }
      if (action === "update" && !Object.keys(b).length && !variables) invalid("Provide at least one update field");
      if ("name" in b && !String(b.name).trim()) invalid("name cannot be empty", "--name");
    },
    run: (c) => save(c, action),
  })),
  {
    path: "environment rebuild",
    description: "Build the Environment's current Base Image and init script again; Sandboxes keep its image until the build succeeds",
    flags: id("environment"),
    write: true,
    effects: "Queues a build of the Environment and supersedes its unfinished one",
    api: ["POST /v1/environments/{id}/build"],
    examples: ["oma-cli environment rebuild --environment-id example-id && oma-cli environment logs --environment-id example-id --follow"],
    run: (c) => write(c, { method: "POST", path: `${base(c, "environment")}/build` }),
  },
  {
    path: "environment logs",
    description: "Read an Environment Build's log, the latest build unless --build-id; --follow prints it as it grows (every 2 s) until the build ends",
    flags: {
      ...id("environment"),
      "build-id": string("One of the Environment's builds; default its latest"),
      follow: boolean("Poll every 2 s until the build has ended"),
      raw: boolean("Only the log text, without the envelope"),
    },
    api: ["GET /v1/environments/{id}/log"],
    output: "data: build, finished, text, offset, nextOffset, truncated. --follow: NDJSON {kind:log,text,…} lines, then {kind:result,data:{build}}; with --raw only the text",
    examples: [
      "oma-cli environment logs --environment-id example-id --follow --raw",
      "oma-cli environment logs --environment-id example-id --build-id envb_example --field build.errorMessage",
    ],
    validate: (f) => {
      if (f.follow && f.field) invalid("--follow streams NDJSON or --raw text; it does not take --field", "--field");
      if (f.follow && f.format && f.format !== "ndjson") invalid("--follow streams NDJSON or --raw text", "--format");
    },
    run: logs,
  },
  {
    path: "environment delete",
    description: "Delete your Environment; Sandboxes already using its image keep it. Built-ins cannot be deleted.",
    flags: id("environment"),
    write: true,
    confirm: true,
    api: ["DELETE /v1/environments/{id}"],
    run: (c) => write(c, { method: "DELETE", path: base(c, "environment") }),
  },
];
