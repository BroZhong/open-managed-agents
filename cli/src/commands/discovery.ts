import { readFile } from "node:fs/promises";
import { boolean, string, type Command, type Values } from "../types.js";
import { commandFlags } from "../input.js";
import { invalid, normalizeError, redact } from "../errors.js";
export const version = "0.1.0";
export function contract(c: Command) {
  const { run, validate, ...data } = c;
  return {
    ...data,
    flags: commandFlags(c),
    dryRun: !!c.write,
    confirmation: c.confirm ? "--yes unless --dry-run" : undefined,
    output: c.output ?? "ok/command/data/meta; raw or field omit envelope",
    effects: c.effects ?? (c.write ? c.description : "Read-only"),
    examples: c.examples ?? [example(c)],
    exclusive: [
      ...(c.exclusive ?? []),
      ["format", "field"],
      ...(c.flags.raw
        ? [
            ["raw", "format"],
            ["raw", "field"],
          ]
        : []),
    ],
    requiredBody: c.requiredBody ?? [],
    api: c.api ?? [],
    dependencies: c.dependencies ?? [],
  };
}
function example(c: Command) {
  let result = "oma-cli " + c.path;
  for (const [k, v] of Object.entries(c.flags))
    if (v.required)
      result += ` --${k} ${v.enum?.[0] ?? (k === "name" ? "oma-cli" : k === "path" ? "notes.txt" : k === "seq" ? "1" : k.endsWith("-id") ? "example-id" : "./example")}`;
  for (const key of c.requiredBody ?? []) {
    const f = Object.entries(c.flags).find(([, v]) => v.field === key);
    if (f) result += ` --${f[0]} ${f[1].enum?.[0] ?? "example"}`;
  }
  if (c.path === "session send") result += ' --prompt "Hello"';
  if (c.confirm) result += " --yes";
  return result;
}
export function help(commands: Command[], path: string): string {
  const exact = commands.find((c) => c.path === path);
  const matches = commands.filter(
    (c) => c.path === path || c.path.startsWith(path ? path + " " : ""),
  );
  if (!matches.length) invalid("Unknown command path; run oma-cli --help");
  if (!exact)
    return (
      `oma-cli ${path}\n` +
      [
        ...new Set(
          matches.map((c) =>
            c.path
              .split(" ")
              .slice(0, path ? path.split(" ").length + 1 : 1)
              .join(" "),
          ),
        ),
      ]
        .map((p) => "  " + p)
        .join("\n") +
      "\nUse <command> --help or schema <command> for parameters.\n"
    );
  const def = contract(exact);
  return (
    `oma-cli ${exact.path}\n${exact.description}\n\n` +
    Object.entries(def.flags)
      .map(
        ([k, v]) =>
          `  --${k}${v.required ? " (required)" : ""}${v.default !== undefined ? " [default: " + v.default + "]" : ""}${v.enum ? " [" + v.enum.join("|") + "]" : ""}  ${v.description}${v.requires ? " (requires " + v.requires.map((x) => "--" + x).join(", ") + ")" : ""}`,
      )
      .join("\n") +
    "\n\n" +
    (exact.bodyFields
      ? "Body fields: " + Object.keys(exact.bodyFields).join(", ") + "\n"
      : "") +
    (exact.requiredBody?.length
      ? "Required body fields (or matching flags): " +
        exact.requiredBody.join(", ") +
        "\n"
      : "") +
    "Examples:\n" +
    def.examples.map((e) => "  " + e).join("\n") +
    "\n"
  );
}
export function discovery(
  commands: Command[],
  schemaTarget: () => string,
): Command[] {
  return [
    {
      path: "schema",
      description:
        "Offline command contracts generated from the executable command registry",
      flags: {
        all: boolean("Entire command tree; conflicts with command path"),
      },
      offline: true,
      validate: (f) => {
        if (f.field || (f.format && f.format !== "json"))
          invalid("schema requires JSON without field", "--format");
        if (f.all && schemaTarget())
          invalid("--all conflicts with command path", "--all");
      },
      run: async (c) => {
        c.flags.format = "json";
        const target = schemaTarget();
        if (!target) return { data: commands.map(contract) };
        const matches = commands.filter(
          (x) => x.path === target || x.path.startsWith(target + " "),
        );
        if (!matches.length)
          invalid(
            "Unknown command path. Candidates: " +
              commands.map((x) => x.path).join(", "),
          );
        return {
          data:
            matches.length === 1 && matches[0]!.path === target
              ? contract(matches[0]!)
              : matches.map(contract),
        };
      },
    },
    {
      path: "version",
      description: "Offline CLI and Node.js versions",
      flags: {},
      offline: true,
      run: async () => ({ data: { version, node: process.version } }),
    },
    {
      path: "guide list",
      description: "List bundled versioned guides",
      flags: {},
      offline: true,
      run: async () => ({
        data: [
          {
            name: "oma-cli",
            title: "oma-cli guide",
            description:
              "Non-interactive commands, workflows, errors and recovery",
          },
        ],
      }),
    },
    {
      path: "guide read",
      description:
        "Read bundled Markdown guide without network or local writes",
      flags: {
        name: string("Guide name", { required: true }),
        raw: boolean("Exact Markdown without added newline"),
      },
      offline: true,
      run: async (c) => {
        if (c.flags.name !== "oma-cli")
          throw Object.assign(
            new Error("Guide not found; run oma-cli guide list"),
            { code: "ENOENT" },
          );
        const content = await readFile(
          new URL("../../guides/oma-cli.md", import.meta.url),
          "utf8",
        );
        return { data: { name: "oma-cli", version, content }, raw: content };
      },
    },
    {
      path: "doctor",
      description:
        "Check runtime, connection configuration, health, authentication and advertised capabilities; never create resources",
      flags: { offline: boolean("Local configuration checks only") },
      offline: true,
      run: async (c) => {
        const rows: Values[] = [];
        const codes: number[] = [];
        const add = (
          name: string,
          status: string,
          message: string,
          hint: string,
          code = 0,
        ) => {
          rows.push({ name, status, message, hint });
          if (code) codes.push(code);
        };
        add(
          "runtime",
          Number(process.versions.node.split(".")[0]) >= 22 ? "ok" : "error",
          `Node ${process.version}; requires >=22`,
          "Use Node.js 22 or newer",
          Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 2,
        );
        let urlOK = false;
        try {
          c.http.url("");
          urlOK = true;
          add(
            "url",
            "ok",
            "HTTP(S) base URL configured",
            "Use --base-url to override OMA_BASE_URL",
          );
        } catch {
          add(
            "url",
            "error",
            "Missing or invalid base URL",
            "Set --base-url or OMA_BASE_URL",
            2,
          );
        }
        add(
          "authentication",
          c.http.key ? "ok" : "error",
          c.http.key ? "API key configured (redacted)" : "API key missing",
          "Set --api-key or OMA_API_KEY",
          c.http.key ? 0 : 2,
        );
        if (!c.flags.offline && urlOK) {
          const check = async (
            name: string,
            fn: () => Promise<any>,
            hint: string,
          ) => {
            try {
              return await fn();
            } catch (e) {
              const error = normalizeError(e);
              add(
                name,
                "error",
                String(redact(error.message, [c.http.key])),
                hint,
                error.code === 4 ? 4 : error.code === 124 ? 124 : 1,
              );
              return undefined;
            }
          };
          const health = await check(
            "health",
            () =>
              c.http.request(c.http.url("/health"), "GET", undefined, {
                signed: true,
              }),
            "Check Host availability and base URL",
          );
          if (health)
            add(
              "health",
              health.status === "ok" ? "ok" : "warn",
              "Host responded",
              "Check deployment health if degraded",
            );
          if (c.http.key) {
            const agents = await check(
              "authenticated-read",
              () => c.http.request("/v1/agents?limit=1"),
              "Check API key and Tenant permissions",
            );
            if (agents)
              add(
                "authenticated-read",
                "ok",
                "Agent read authorized",
                "No action required",
              );
          }
          const spec = await check(
            "capabilities",
            () =>
              c.http.request(c.http.url("/openapi.json"), "GET", undefined, {
                signed: true,
              }),
            "Verify Host OpenAPI endpoint",
          );
          if (spec) {
            const paths = spec.paths ?? {};
            const missing = [
              "/v1/agents",
              "/v1/sessions/{id}/events",
              "/v1/workspaces",
              "/v1/skills",
            ].filter((p) => !paths[p]);
            add(
              "capabilities",
              missing.length ? "warn" : "ok",
              missing.length
                ? "Missing advertised routes: " + missing.join(", ")
                : "Core routes advertised",
              "Use schema for per-command API requirements",
            );
          }
          add(
            "reliable-wait",
            "warn",
            "OpenAPI alone cannot attest atomic queue-drain behavior",
            "Verify Host includes PR #179 and run the documented queue-drain contract test before relying on wait",
          );
        }
        const code = [2, 4, 124, 1].find((x) => codes.includes(x)) ?? 0;
        return { data: rows, code };
      },
    },
  ];
}
