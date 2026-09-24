import { readFile } from "node:fs/promises";
import { invalid } from "./errors.js";
import {
  boolean,
  string,
  type Command,
  type Flag,
  type Values,
} from "./types.js";
export const globals: Record<string, Flag> = {
  "base-url": string("Host base URL; overrides OMA_BASE_URL"),
  "api-key": string("Host API key; overrides OMA_API_KEY"),
  format: string("Output format", { enum: ["json", "table", "csv", "ndjson"] }),
  field: string("Extract a path relative to data"),
  "no-color": boolean("Disable color"),
  verbose: boolean("Diagnostics on stderr"),
  timeout: {
    type: "duration",
    description: "Single HTTP connection/inactivity timeout",
    default: "30s",
  },
  help: boolean("Offline help"),
  version: boolean("Offline version"),
};
export function duration(value: unknown, param: string, zero = true): number {
  if (value === "0" && zero) return 0;
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?(?:ms|s|m|h)$/.test(value))
    invalid(
      "Expected a positive duration such as 30s, 2h" + (zero ? " or 0" : ""),
      param,
    );
  const m = value.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/)!;
  const n = Number(m[1]) * { ms: 1, s: 1000, m: 60000, h: 3600000 }[m[2]!]!;
  if (!Number.isFinite(n) || n <= 0 || n > Number.MAX_SAFE_INTEGER)
    invalid("Duration out of range", param);
  return n;
}
export function check(value: unknown, def: Flag, param: string): any {
  if (def.type === "boolean") {
    if (typeof value !== "boolean") invalid("Expected a boolean", param);
  } else if (def.type === "integer") {
    if (typeof value === "string" && /^(0|[1-9]\d*)$/.test(value))
      value = Number(value);
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < (def.min ?? 0) ||
      value > (def.max ?? Number.MAX_SAFE_INTEGER)
    )
      invalid("Integer out of range", param);
  } else if (def.type === "duration")
    duration(value, param, param !== "--timeout");
  else if (def.type !== "json" && typeof value !== "string")
    invalid("Expected a string", param);
  if (def.enum && !def.enum.includes(String(value)))
    invalid(`Expected one of ${def.enum.join(", ")}`, param);
  return value;
}
export function parse(
  argv: string[],
  commands: Command[],
): { words: string[]; flags: Values } {
  const definitions = { ...globals };
  for (const c of commands) Object.assign(definitions, c.flags);
  Object.assign(definitions, {
    "dry-run": boolean("Preview"),
    yes: boolean("Confirm"),
    body: string("JSON body"),
  });
  const words: string[] = [],
    flags: Values = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) {
      if (a.startsWith("-")) invalid("Use explicit long flags", a);
      words.push(a);
      continue;
    }
    const split = a.indexOf("=");
    const k = a.slice(2, split < 0 ? undefined : split);
    const def = Object.hasOwn(definitions, k) ? definitions[k] : undefined;
    if (!def) invalid("Unknown flag", `--${k}`);
    if (k in flags) invalid("Repeated flag", `--${k}`);
    if (def.type === "boolean") {
      if (split >= 0) invalid("Boolean flags do not accept a value", `--${k}`);
      flags[k] = true;
    } else {
      const v = split >= 0 ? a.slice(split + 1) : argv[++i];
      if (v === undefined || v.startsWith("--"))
        invalid("Missing flag value", `--${k}`);
      flags[k] = v;
    }
  }
  return { words, flags };
}
export function utf8(bytes: Uint8Array, param: string): string {
  try {
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    if (/[\x00-\x08\x0e-\x1f]/.test(text))
      invalid(
        "Binary text is not supported; use workspace file upload/download",
        param,
      );
    return text;
  } catch (e) {
    if (e instanceof TypeError)
      invalid("Invalid UTF-8; use workspace file upload/download", param);
    throw e;
  }
}
async function textInput(path: string): Promise<string> {
  if (path === "-") {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(Buffer.from(c));
    return utf8(Buffer.concat(chunks), "stdin");
  }
  return utf8(await readFile(path), path);
}
export function remotePath(
  value: string,
  skill = false,
  prefix = false,
  root = false,
): string {
  if (root && value === ".") return "";
  const p = prefix && value.endsWith("/") ? value.slice(0, -1) : value;
  if (
    !p ||
    /[\\\x00-\x1f\x7f]/.test(p) ||
    p.split("/").some((s) => !s || s === "." || s === "..") ||
    (skill && p.trim() !== p) ||
    /^[A-Za-z]:/.test(p)
  )
    invalid("Expected a safe relative path", "--path");
  return p;
}
export function workspaceId(value: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value))
    invalid(
      "Workspace ID must be 1–128 ASCII letters, numbers, underscores or hyphens",
      "--workspace-id",
    );
}
export function commandFlags(command: Command): Record<string, Flag> {
  return {
    ...globals,
    ...command.flags,
    ...(command.write ? { "dry-run": boolean("Preview without writes") } : {}),
    ...(command.confirm ? { yes: boolean("Confirm deletion") } : {}),
    ...(command.bodyFields
      ? { body: string("JSON, @UTF-8-file or - for stdin") }
      : {}),
  };
}
export async function prepare(
  command: Command,
  provided: Values,
): Promise<{ flags: Values; body: Values }> {
  const defs = commandFlags(command);
  const flags: Values = { ...provided };
  for (const k of Object.keys(flags)) {
    if (!Object.hasOwn(defs, k))
      invalid("Flag does not apply to this command", `--${k}`);
    flags[k] = check(flags[k], defs[k]!, `--${k}`);
  }
  if (flags.field && flags.format)
    invalid("--field conflicts with --format", "--field");
  if (flags.raw && (flags.format || flags.field))
    invalid("--raw conflicts with --format/--field", "--raw");
  if (
    flags["dry-run"] &&
    (flags.field || flags.raw || (flags.format && flags.format !== "json"))
  )
    invalid("dry-run requires JSON without field/raw", "--dry-run");
  for (const group of command.exclusive ?? [])
    if (group.filter((k) => k in provided).length > 1)
      invalid(`Choose only one of ${group.map((k) => "--" + k).join(", ")}`);
  for (const k of Object.keys(provided))
    for (const required of defs[k]?.requires ?? [])
      if (!provided[required])
        invalid(`--${k} requires --${required}`, `--${k}`);
  const stdin = Object.entries(provided).filter(
    ([k, v]) => v === "-" && (k === "body" || defs[k]?.source === "text-file"),
  );
  if (stdin.length > 1) invalid("Only one stdin consumer is allowed");
  let body: Values = {};
  if (flags.body !== undefined) {
    let t = flags.body;
    if (t === "-") t = await textInput("-");
    else if (t.startsWith("@")) t = await textInput(t.slice(1));
    try {
      body = JSON.parse(t);
    } catch {
      invalid("Invalid JSON body", "--body");
    }
    if (!body || typeof body !== "object" || Array.isArray(body))
      invalid("Body must be a JSON object", "--body");
  }
  for (const [k, v] of Object.entries(body)) {
    const def =
      command.bodyFields && Object.hasOwn(command.bodyFields, k)
        ? command.bodyFields[k]
        : undefined;
    if (!def) invalid(`Unknown body field ${k}`, "--body");
    body[k] = check(v, def, `body.${k}`);
  }
  for (const [k, def] of Object.entries(command.flags)) {
    if (k in provided && def.field) {
      if (def.field in body) invalid(`Duplicate field ${def.field}`, "--" + k);
      body[def.field] =
        def.source === "text-file" ? await textInput(flags[k]) : flags[k];
    }
  }
  for (const field of command.requiredBody ?? [])
    if (!(field in body))
      invalid(`Missing required field ${field}`, "--" + field);
  for (const [k, def] of Object.entries(defs)) {
    if (def.required && !(k in flags))
      invalid(def.missingHint ?? "Missing required flag", "--" + k);
    if (!(k in flags) && def.default !== undefined) flags[k] = def.default;
  }
  if (command.confirm && !flags.yes && !flags["dry-run"])
    invalid("This operation requires --yes; inspect --dry-run first", "--yes");
  for (const k of ["agent-id", "session-id", "skill-id", "workspace-id"])
    if (k in flags && typeof flags[k] === "string" && !flags[k])
      invalid("ID cannot be empty", "--" + k);
  command.validate?.(flags, body);
  return { flags, body };
}
